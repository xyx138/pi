import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tavilySearchExtension, {
	createTavilyKeyInput,
	readTavilyApiKey,
	saveTavilyApiKey,
	tavilySearchTool,
} from "../examples/extensions/tavily-search.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../src/core/extensions/types.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const tool = wrapToolDefinition(tavilySearchTool);

describe("Tavily search extension", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-tavily-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TAVILY_API_KEY", "test-secret");
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("loads through the project extension entry and registers the search tool", async () => {
		const entry = fileURLToPath(new URL("../../../.pi/extensions/tavily-search.ts", import.meta.url));
		const loaded = await loadExtensions([entry], process.cwd());
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect(loaded.extensions[0].tools.has("tavily_search")).toBe(true);
		expect(loaded.extensions[0].commands.has("tavily")).toBe(true);
	});

	it("authenticates and returns bounded source excerpts with defaults", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ title: "Example", url: "https://example.com/article", content: "x".repeat(2500) }],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await tool.execute("call-1", { query: "  TypeScript news  " });
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.tavily.com/search");
		expect(options.headers.Authorization).toBe("Bearer test-secret");
		expect(JSON.parse(options.body)).toEqual({
			query: "TypeScript news",
			max_results: 5,
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
			auto_parameters: false,
		});
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("https://example.com/article") }]);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("[Excerpt truncated]") }]);
		expect(JSON.stringify(result)).not.toContain("test-secret");
	});

	it("forwards search options and respects the requested result limit", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ title: "First", url: "https://example.com/1", content: "one" },
						{ title: "Second", url: "https://example.com/2", content: "two" },
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await tool.execute("call", {
			query: "news",
			max_results: 1,
			search_depth: "advanced",
			time_range: "week",
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
			max_results: 1,
			search_depth: "advanced",
			time_range: "week",
		});
		expect(result.details.results).toHaveLength(1);
	});

	it("rejects missing credentials and blank queries without a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("TAVILY_API_KEY", "");
		await expect(tool.execute("call", { query: "news" })).rejects.toThrow("Run /tavily");
		vi.stubEnv("TAVILY_API_KEY", "test-secret");
		await expect(tool.execute("call", { query: "   " })).rejects.toThrow("must not be blank");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([401, 429, 432, 500])("handles HTTP %i without leaking the response body", async (status) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("test-secret", { status })));
		await expect(tool.execute("call", { query: "news" })).rejects.toThrow(`HTTP ${status}`);
	});

	it("handles an empty result set", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"results":[]}')));
		const result = await tool.execute("call", { query: "news" });
		expect(result.content).toEqual([{ type: "text", text: "No search results found for: news" }]);
	});

	it.each([{}, { results: [{}] }, { results: [{ title: "bad", url: "javascript:alert(1)", content: "bad" }] }])(
		"rejects malformed search responses",
		async (body) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
			await expect(tool.execute("call", { query: "news" })).rejects.toThrow("invalid");
		},
	);

	it("forwards caller cancellation to the HTTP request", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
					}),
			),
		);
		const request = tool.execute("call", { query: "news" }, controller.signal);
		const assertion = expect(request).rejects.toThrow("cancelled");
		controller.abort();
		await assertion;
	});

	it("times out stalled requests", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeoutController.signal);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
					}),
			),
		);
		const request = tool.execute("call", { query: "news" });
		const assertion = expect(request).rejects.toThrow("timed out after 30 seconds");
		timeoutController.abort();
		await assertion;
	});

	it("persists credentials with private permissions and uses them without environment configuration", async () => {
		vi.stubEnv("TAVILY_API_KEY", "");
		saveTavilyApiKey("  saved-secret  ");
		expect(JSON.parse(readFileSync(join(agentDir, "tavily.json"), "utf8"))).toEqual({ apiKey: "saved-secret" });
		if (process.platform !== "win32") expect(statSync(join(agentDir, "tavily.json")).mode & 0o777).toBe(0o600);
		expect(readTavilyApiKey()).toBe("saved-secret");
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"results":[]}'));
		vi.stubGlobal("fetch", fetchMock);
		await tool.execute("call", { query: "news" });
		expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer saved-secret");
		saveTavilyApiKey("replacement");
		expect(readTavilyApiKey()).toBe("replacement");
	});

	it("prefers the environment key over saved credentials", () => {
		saveTavilyApiKey("saved-secret");
		expect(readTavilyApiKey()).toBe("test-secret");
	});

	it("rejects malformed credential files without revealing their contents", () => {
		vi.stubEnv("TAVILY_API_KEY", "");
		writeFileSync(join(agentDir, "tavily.json"), "broken-secret");
		expect(readTavilyApiKey).toThrow("Cannot read Tavily credentials");
		saveTavilyApiKey("fixed-secret");
		expect(readTavilyApiKey()).toBe("fixed-secret");
	});

	it("never renders a typed or pasted API key and supports editing and cancellation", () => {
		const done = vi.fn();
		const input = createTavilyKeyInput(done);
		input.focused = true;
		expect(input.render(80).join("\n")).toContain("(0 characters)");
		input.handleInput("\x1b[200~tvly-hidden-secret\x1b[201~");
		expect(input.render(80).join("\n")).toContain("*".repeat(18));
		expect(input.render(80).join("\n")).toContain("(18 characters)");
		expect(input.render(80).join("\n")).not.toContain("tvly-hidden-secret");
		input.handleInput("\x7f");
		expect(input.render(80).join("\n")).toContain("(17 characters)");
		input.handleInput("\r");
		expect(done).toHaveBeenCalledWith("tvly-hidden-secre");
		expect(input.render(80).join("\n")).toContain("(0 characters)");
		expect(input.render(80).join("\n")).not.toContain("tvly-hidden");
		const cancel = vi.fn();
		const cancelledInput = createTavilyKeyInput(cancel);
		cancelledInput.handleInput("\r");
		expect(cancel).not.toHaveBeenCalled();
		cancelledInput.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledWith(undefined);
	});

	it("moves the masked cursor and edits at its actual position", () => {
		const done = vi.fn();
		const input = createTavilyKeyInput(done);
		input.focused = true;
		input.handleInput("abcd");
		expect(input.render(80).at(-1)).toContain(`> ****${CURSOR_MARKER}\x1b[7m \x1b[27m`);
		input.handleInput("\x1b[D");
		expect(input.render(80).at(-1)).toContain(`> ***${CURSOR_MARKER}\x1b[7m*\x1b[27m`);
		input.handleInput("X");
		expect(input.render(80).at(-1)).toContain(`> ****${CURSOR_MARKER}\x1b[7m*\x1b[27m`);
		input.handleInput("\x7f");
		input.handleInput("\x1b[C");
		expect(input.render(80).at(-1)).toContain(`> ****${CURSOR_MARKER}\x1b[7m \x1b[27m`);
		input.handleInput("\r");
		expect(done).toHaveBeenCalledWith("abcd");
	});

	it("keeps the cursor visible when a long masked key scrolls in a narrow terminal", () => {
		const input = createTavilyKeyInput(vi.fn());
		input.focused = true;
		input.handleInput("\x1b[200~tvly-long-secret-key-for-scrolling\x1b[201~");
		const line = input.render(12).at(-1)!;
		expect(visibleWidth(line)).toBe(12);
		expect(line).toContain(CURSOR_MARKER);
		expect(line).not.toContain("tvly");
		input.handleInput("\x01");
		expect(input.render(12).at(-1)).toContain(`> ${CURSOR_MARKER}\x1b[7m*\x1b[27m`);
	});

	it("configures credentials through the command without sending messages", async () => {
		vi.stubEnv("TAVILY_API_KEY", "");
		const loaded = await loadExtensions(
			[fileURLToPath(new URL("../examples/extensions/tavily-search.ts", import.meta.url))],
			process.cwd(),
		);
		const handler = loaded.extensions[0].commands.get("tavily")!.handler;
		const notify = vi.fn();
		const custom = vi.fn().mockResolvedValue("dialog-secret");
		const ctx = { mode: "tui", ui: { custom, notify } } as unknown as ExtensionCommandContext;
		await handler("", ctx);
		expect(readTavilyApiKey()).toBe("dialog-secret");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no restart"), "info");
		expect(JSON.stringify(notify.mock.calls)).not.toContain("dialog-secret");
		custom.mockResolvedValueOnce(undefined);
		await handler("", ctx);
		expect(readTavilyApiKey()).toBe("dialog-secret");
		custom.mockClear();
		await handler("", { mode: "print", ui: { notify } } as unknown as ExtensionCommandContext);
		await handler("do-not-enter-keys-here", ctx);
		expect(custom).not.toHaveBeenCalled();
	});

	it("shows configuration guidance at interactive startup only when credentials are missing", async () => {
		let start: ((event: SessionStartEvent, ctx: ExtensionContext) => void) | undefined;
		const api = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: (_event: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => void) => {
				start = handler;
			},
		} as unknown as ExtensionAPI;
		tavilySearchExtension(api);
		const notify = vi.fn();
		const ctx = { mode: "tui", ui: { notify } } as unknown as ExtensionContext;
		vi.stubEnv("TAVILY_API_KEY", "");
		start!({ type: "session_start", reason: "startup" }, ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run /tavily"), "info");
		notify.mockClear();
		saveTavilyApiKey("saved-secret");
		start!({ type: "session_start", reason: "startup" }, ctx);
		expect(notify).not.toHaveBeenCalled();
	});
});
