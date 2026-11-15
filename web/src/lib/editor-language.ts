import type { Extension } from "@codemirror/state";

const CUDA_KEYWORDS =
  /^(__global__|__device__|__host__|__shared__|__constant__|__managed__|__restrict__|__forceinline__|__noinline__|__launch_bounds__|__grid_constant__)$/;
const CUDA_BUILTINS =
  /^(threadIdx|blockIdx|blockDim|gridDim|warpSize|(u?(char|short|int|long|longlong)|float|double)[1-4]|dim3|half2?|__half2?|__nv_bfloat16|cudaStream_t|cudaError_t)$/;

/** The language packs the editor loads on demand, by the name `languageOf` gives a file. */
const PACKS = {
  javascript: async () =>
    (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  typescript: async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      typescript: true,
    }),
  tsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      typescript: true,
      jsx: true,
    }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  /*
   * CUDA has no Lezer grammar, and the C++ one reports errors on kernel
   * launches (`k<<<grid, block>>>(x)`) and on qualifiers such as `__global__`,
   * which breaks highlighting and indentation after them. So CUDA is the
   * forgiving legacy C++ stream mode, with CUDA's qualifiers marked as keywords
   * and its built-in variables and vector types as standard names.
   */
  cuda: async () => {
    const [{ StreamLanguage }, { cpp }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/clike"),
    ]);
    return StreamLanguage.define({
      ...cpp,
      token(stream, state) {
        const style = cpp.token(stream, state);
        if (style && !/^(variable|builtin|type|keyword)/.test(style))
          return style;
        const word = stream.current();
        if (CUDA_KEYWORDS.test(word)) return "keyword";
        if (CUDA_BUILTINS.test(word)) return "variableName.standard";
        return style;
      },
    });
  },
  shell: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/shell"),
    ]);
    return StreamLanguage.define(shell);
  },
  toml: async () => {
    const [{ StreamLanguage }, { toml }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/toml"),
    ]);
    return StreamLanguage.define(toml);
  },
} satisfies Record<string, () => Promise<Extension>>;

export type EditorLanguage = keyof typeof PACKS;

const BY_EXTENSION: Record<string, EditorLanguage> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  css: "css",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  sql: "sql",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  "h++": "cpp",
  inl: "cpp",
  ipp: "cpp",
  tpp: "cpp",
  cu: "cuda",
  cuh: "cuda",
};

/** The language a file is written in, by its extension; none means plain text. */
export function languageOf(name: string): EditorLanguage | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The language's highlighting and indentation, loaded now. */
export async function loadLanguage(name: string): Promise<Extension | null> {
  const language = languageOf(name);
  return language ? PACKS[language]() : null;
}
