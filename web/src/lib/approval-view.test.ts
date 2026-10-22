import { describe, expect, it } from "vitest";
import { approvalView, resultView } from "~/lib/approval-view";

describe("approvalView", () => {
  it("shows an app's tool call as the app, the tool, and one field per argument", () => {
    const view = approvalView({
      id: "a1",
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
      id: "a1",
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

  it("shows an agent's new icon as the picture, without its hash", () => {
    const view = approvalView({
      id: "a2",
      action: "update_agent",
      args: {
        agent: "p_coach",
        icon: "/workspace/images/coach.png",
        icon_sha256: "ab12",
        instructions: "Coach my runs.\nRest on Mondays.",
      },
      summary:
        "Sam makes Coach's icon the image at /workspace/images/coach.png, changes Coach's instructions",
    });
    expect(view.fields).toEqual([
      { name: "icon", kind: "image", src: "/api/approvals/a2/icon" },
      { name: "agent", kind: "text", text: "p_coach" },
      {
        name: "instructions",
        kind: "code",
        code: "Coach my runs.\nRest on Mondays.",
        language: "text",
      },
    ]);
  });

  it("shows each file a request would save under its path, as code", () => {
    const view = approvalView({
      id: "a1",
      action: "write_skill",
      args: {
        name: "weekly-plan",
        files: [
          { path: "scripts/paces.js", content: "export const easy = 1;" },
          { path: "references/notes.md", content: "Run easy.\nRest after." },
          {
            path: "templates/plan.docx",
            from_file: "/workspace/plan.docx",
            sha256: "ab12",
            size: 9000,
          },
          {
            path: "reference/fonts.md",
            from_url:
              "https://raw.githubusercontent.com/acme/skills/abc/fonts.md",
            sha256: "cd34",
            size: 40,
          },
        ],
      },
      summary: "Coach saves a new skill: weekly-plan",
    });
    expect(view.fields).toEqual([
      {
        name: "scripts/paces.js",
        kind: "code",
        code: "export const easy = 1;",
        language: "javascript",
      },
      {
        name: "references/notes.md",
        kind: "code",
        code: "Run easy.\nRest after.",
        language: "text",
      },
      {
        name: "templates/plan.docx",
        kind: "text",
        text: "/workspace/plan.docx",
      },
      {
        name: "reference/fonts.md",
        kind: "text",
        text: "https://raw.githubusercontent.com/acme/skills/abc/fonts.md",
      },
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
