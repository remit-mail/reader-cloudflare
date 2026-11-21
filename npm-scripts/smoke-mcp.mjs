export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const callMcp = async (url, headers, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    redirect: "manual",
  });
  const text = await response.text();
  const data = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
    : text;
  return {
    status: response.status,
    body: data === undefined || data === "" ? undefined : JSON.parse(data),
  };
};
