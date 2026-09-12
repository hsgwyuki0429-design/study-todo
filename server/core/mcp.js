// MCP（Model Context Protocol）のサーバー実装。
//
// 最新仕様 2026-07-28 に合わせている。この版のMCPは「状態を持たない」形に変わり、
// 以前の initialize / notifications/initialized の握手と Mcp-Session-Id は無くなった。
// 代わりに、1回ごとのリクエストが自分でプロトコル版とクライアント情報を運ぶ。
//
//   POST /mcp
//   MCP-Protocol-Version: 2026-07-28
//   Mcp-Method: tools/call
//   Mcp-Name: searchQuestions
//   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...,"_meta":{...}}}
//
// 古いクライアントもまだ多いので、initialize を送ってくる版（2025-03-26 〜
// 2025-11-25）にも同じ入口で応える。特定のAIに合わせた分岐は持たない。

export const LATEST_PROTOCOL_VERSION = "2026-07-28";

/** 新しい順。先頭が既定。 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);

/** initialize の握手を使う古い版。 */
export const HANDSHAKE_PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const ERROR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // MCP が定める番号（-32020 から順に割り当てられている）。
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
});

/** 一覧の結果に付ける、クライアント側で使ってよいキャッシュの目安。 */
const LIST_CACHE = Object.freeze({ ttlMs: 60_000, cacheScope: "private" });

function resultResponse(id, result, serverInfo) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      // 2026-07-28 から、結果は「完了したのか、追加入力が要るのか」を必ず示す。
      resultType: "complete",
      ...result,
      _meta: { [META_SERVER_INFO]: serverInfo, ...(result._meta ?? {}) },
    },
  };
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/** ツール定義から、MCPが返す形（Tool）へ整える。 */
function describeTool(tool) {
  const described = {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  if (tool.outputSchema) described.outputSchema = tool.outputSchema;
  if (tool.annotations) described.annotations = { title: tool.title ?? tool.name, ...tool.annotations };
  return described;
}

/**
 * ツールの戻り値を CallToolResult にする。
 * AIが読む文章（content）と、プログラムが読む構造（structuredContent）の両方を返す。
 */
export function toolResult(value, { isError = false, text = null } = {}) {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpServer({ serverInfo, instructions, tools, capabilities = {} }) {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const serverCapabilities = { tools: { listChanged: false }, ...capabilities };

  /** ヘッダーと本文から、この呼び出しで使うプロトコル版を決める。 */
  function negotiateVersion(message, headers) {
    const headerVersion = headerOf(headers, "MCP-Protocol-Version");
    const metaVersion = message?.params?._meta?.[META_PROTOCOL_VERSION];
    const initializeVersion = message?.method === "initialize" ? message?.params?.protocolVersion : null;

    if (headerVersion && metaVersion && headerVersion !== metaVersion) {
      return {
        error: {
          status: 400,
          code: ERROR.HEADER_MISMATCH,
          message: "MCP-Protocol-Version ヘッダーと _meta のプロトコル版が一致しません。",
          data: { header: "MCP-Protocol-Version", headerValue: headerVersion, bodyValue: metaVersion },
        },
      };
    }
    const requested = headerVersion ?? metaVersion ?? initializeVersion;
    if (!requested) {
      // 版の指定が無いのは古いクライアント。握手ありの版として扱う。
      return { version: "2025-06-18", declared: false };
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
      return {
        error: {
          status: 400,
          code: ERROR.UNSUPPORTED_PROTOCOL_VERSION,
          message: `プロトコル版 ${requested} には対応していません。`,
          data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested },
        },
      };
    }
    return { version: requested, declared: true };
  }

  /**
   * 2026-07-28 のヘッダーは、本文と食い違っていたら推測せずに拒む。
   * 中継や入口のサーバーがヘッダーだけを見て振り分けても、食い違いが起きないようにするため。
   */
  function checkRoutingHeaders(message, headers) {
    const method = headerOf(headers, "Mcp-Method");
    if (method && method !== message.method) {
      return {
        status: 400,
        code: ERROR.HEADER_MISMATCH,
        message: "Mcp-Method ヘッダーと本文の method が一致しません。",
        data: { header: "Mcp-Method", headerValue: method, bodyValue: message.method },
      };
    }
    const name = headerOf(headers, "Mcp-Name");
    const bodyName = message.method === "tools/call" ? message.params?.name : undefined;
    if (name && bodyName !== undefined && name !== bodyName) {
      return {
        status: 400,
        code: ERROR.HEADER_MISMATCH,
        message: "Mcp-Name ヘッダーと本文のツール名が一致しません。",
        data: { header: "Mcp-Name", headerValue: name, bodyValue: bodyName },
      };
    }
    return null;
  }

  async function dispatch(message, version, context) {
    const { id, method, params = {} } = message;

    if (method === "server/discover") {
      return resultResponse(id, {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: serverCapabilities,
        instructions,
        ...LIST_CACHE,
      }, serverInfo);
    }

    // 古い版の握手。返す内容は server/discover と同じ情報。
    if (method === "initialize") {
      const requested = params.protocolVersion;
      const agreed = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : "2025-06-18";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: agreed,
          capabilities: serverCapabilities,
          serverInfo,
          instructions,
        },
      };
    }

    if (method === "ping") return resultResponse(id, {}, serverInfo);

    if (method === "tools/list") {
      return resultResponse(id, {
        tools: [...toolMap.values()].map(describeTool),
        ...LIST_CACHE,
      }, serverInfo);
    }

    if (method === "tools/call") {
      const name = params.name;
      const tool = toolMap.get(name);
      if (!tool) {
        return errorResponse(id, ERROR.INVALID_PARAMS, `ツール ${name} はありません。`, {
          available: [...toolMap.keys()],
        });
      }
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return errorResponse(id, ERROR.INVALID_PARAMS, "arguments はオブジェクトで渡してください。");
      }
      // ツールの中で起きた失敗は、プロトコルの誤りではなく結果として返す。
      // そうしないとAIが「何が駄目だったか」を読めず、同じ失敗を繰り返す。
      const result = await tool.handler(args, { ...context, protocolVersion: version, toolName: name });
      return resultResponse(id, result, serverInfo);
    }

    return errorResponse(id, ERROR.METHOD_NOT_FOUND, `メソッド ${method} には対応していません。`);
  }

  return {
    serverInfo,
    tools: [...toolMap.values()],
    describeTools: () => [...toolMap.values()].map(describeTool),

    /**
     * JSON-RPC のメッセージを1つ処理する。
     * 戻り値の status は、HTTPの応答をそのまま組み立てられるようにしてある。
     */
    async handle(rawBody, headers = {}, context = {}) {
      let message = rawBody;
      if (typeof rawBody === "string") {
        try {
          message = JSON.parse(rawBody);
        } catch {
          return { status: 400, body: errorResponse(null, ERROR.PARSE, "JSONとして読み取れませんでした。") };
        }
      }
      if (Array.isArray(message)) {
        return {
          status: 400,
          body: errorResponse(null, ERROR.INVALID_REQUEST, "まとめ送り（バッチ）には対応していません。1件ずつ送ってください。"),
        };
      }
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return { status: 400, body: errorResponse(message?.id, ERROR.INVALID_REQUEST, "JSON-RPC 2.0 の形式ではありません。") };
      }

      const negotiated = negotiateVersion(message, headers);
      if (negotiated.error) {
        const { status, code, message: text, data } = negotiated.error;
        return { status, body: errorResponse(message.id, code, text, data) };
      }
      const routingError = checkRoutingHeaders(message, headers);
      if (routingError) {
        return {
          status: routingError.status,
          body: errorResponse(message.id, routingError.code, routingError.message, routingError.data),
        };
      }

      // 通知（idが無いもの）には本文を返さない。古い版の notifications/initialized など。
      if (message.id === undefined || message.id === null) {
        return { status: 202, body: null };
      }

      try {
        const body = await dispatch(message, negotiated.version, {
          ...context,
          clientInfo: message.params?._meta?.[META_CLIENT_INFO] ?? context.clientInfo ?? null,
          clientCapabilities: message.params?._meta?.[META_CLIENT_CAPABILITIES] ?? null,
        });
        return { status: 200, body };
      } catch (error) {
        return {
          status: 200,
          body: errorResponse(message.id, ERROR.INTERNAL, error?.message ?? "サーバー側で問題が起きました。"),
        };
      }
    },
  };
}
