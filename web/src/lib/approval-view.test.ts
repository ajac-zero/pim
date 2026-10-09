import { describe, expect, it } from "vitest";
import { approvalView, resultView } from "~/lib/approval-view";

describe("approvalView", () => {
  it("shows an app's tool call as the app, the tool, and one field per argument", () => {
    const view = approvalView({
      action: "mcp_call",
      args: {
        server: "cf-1",
        tool: "execute",
        arguments: {
          account_id: "50fc740fb96dd3b4d9aeacd257575377",
          code: "async () => { return await cloudflare.request({ method: 'GET' }); }",
          query: { page: 1 },
          filter: '{"status":"active"}',
          dry_run: false,
        },
      },
      summary:
        'Cloudflare: execute {"account_id":"50fc740fb96dd3b4d9aeacd257575377","code":"async () => …"}',
    });
    expect(view.title).toBe("Cloudflare · execute");
    expect(view.fields).toEqual([
      {
        name: "account_id",
        kind: "text",
        text: "50fc740fb96dd3b4d9aeacd257575377",
      },
      {
        name: "code",
        kind: "code",
        code: "async () => { return await cloudflare.request({ method: 'GET' }); }",
        language: "javascript",
      },
      {
        name: "query",
        kind: "code",
        code: '{\n  "page": 1\n}',
        language: "json",
      },
      {
        name: "filter",
        kind: "code",
        code: '{\n  "status": "active"\n}',
        language: "json",
      },
      { name: "dry_run", kind: "text", text: "false" },
    ]);
  });

  it("keeps Pim's own summary and shows only what it leaves out", () => {
    const view = approvalView({
      action: "http_request",
      args: {
        method: "POST",
        url: "https://hooks.example.com/deploy",
        body: "env=prod",
      },
      summary: "POST https://hooks.example.com/deploy with a 8-character body",
    });
    expect(view.title).toBe(
      "POST https://hooks.example.com/deploy with a 8-character body",
    );
    expect(view.fields).toEqual([
      { name: "body", kind: "text", text: "env=prod" },
    ]);
  });
});

describe("resultView", () => {
  it("separates a status line from a JSON body", () => {
    expect(resultView('HTTP 200 OK\n{"ok":true}')).toEqual({
      lead: "HTTP 200 OK",
      code: '{\n  "ok": true\n}',
      language: "json",
    });
  });

  it("formats JSON, and leaves other text as it is", () => {
    expect(resultView('[{"id":1}]').code).toBe('[\n  {\n    "id": 1\n  }\n]');
    expect(resultView("Connected.\nSign in at https://x")).toEqual({
      lead: null,
      code: "Connected.\nSign in at https://x",
      language: "text",
    });
  });
});
