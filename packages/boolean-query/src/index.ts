export type BooleanAst =
  | { type: "term"; value: string; phrase: boolean }
  | { type: "not"; child: BooleanAst }
  | { type: "and"; children: BooleanAst[] }
  | { type: "or"; children: BooleanAst[] };

export type Token =
  | { type: "TERM"; value: string; phrase: boolean }
  | { type: "AND" | "OR" | "NOT" | "LPAREN" | "RPAREN" };

export class BooleanQueryError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] ?? "";
    if (isSpace(char)) { i += 1; continue; }
    if (char === "(") { tokens.push({ type: "LPAREN" }); i += 1; continue; }
    if (char === ")") { tokens.push({ type: "RPAREN" }); i += 1; continue; }
    if (char === '"') {
      const start = i;
      i += 1;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const current = input[i] ?? "";
        if (current === "\\" && input[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (current === '"') { closed = true; i += 1; break; }
        value += current;
        i += 1;
      }
      if (!closed) throw new BooleanQueryError("Unterminated quoted phrase", start);
      if (!value.trim()) throw new BooleanQueryError("Empty quoted phrase", start);
      tokens.push({ type: "TERM", value: value.trim(), phrase: true });
      continue;
    }

    const start = i;
    let value = "";
    while (i < input.length) {
      const current = input[i] ?? "";
      if (isSpace(current) || current === "(" || current === ")") break;
      value += current;
      i += 1;
    }
    if (!value) throw new BooleanQueryError("Unexpected token", start);
    const upper = value.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "NOT") tokens.push({ type: upper });
    else tokens.push({ type: "TERM", value, phrase: false });
  }
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): BooleanAst {
    if (!this.tokens.length) throw new BooleanQueryError("Query is empty", 0);
    const result = this.parseOr();
    if (this.peek()) throw new BooleanQueryError("Unexpected trailing token", this.index);
    return result;
  }

  private parseOr(): BooleanAst {
    const children = [this.parseAnd()];
    while (this.peek()?.type === "OR") {
      this.index += 1;
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0]! : { type: "or", children: flatten("or", children) };
  }

  private parseAnd(): BooleanAst {
    const children = [this.parseUnary()];
    while (true) {
      const token = this.peek();
      if (token?.type === "AND") {
        this.index += 1;
        children.push(this.parseUnary());
        continue;
      }
      if (token && (token.type === "TERM" || token.type === "LPAREN" || token.type === "NOT")) {
        children.push(this.parseUnary());
        continue;
      }
      break;
    }
    return children.length === 1 ? children[0]! : { type: "and", children: flatten("and", children) };
  }

  private parseUnary(): BooleanAst {
    const token = this.peek();
    if (!token) throw new BooleanQueryError("Expected term", this.index);
    if (token.type === "NOT") {
      this.index += 1;
      return { type: "not", child: this.parseUnary() };
    }
    if (token.type === "LPAREN") {
      this.index += 1;
      const expression = this.parseOr();
      if (this.peek()?.type !== "RPAREN") throw new BooleanQueryError("Missing closing parenthesis", this.index);
      this.index += 1;
      return expression;
    }
    if (token.type === "TERM") {
      this.index += 1;
      return { type: "term", value: token.value, phrase: token.phrase };
    }
    throw new BooleanQueryError(`Unexpected ${token.type}`, this.index);
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function flatten(type: "and" | "or", children: BooleanAst[]): BooleanAst[] {
  const output: BooleanAst[] = [];
  for (const child of children) {
    if (child.type === type) output.push(...child.children);
    else output.push(child);
  }
  return output;
}

export function parseBooleanQuery(input: string): BooleanAst {
  return new Parser(tokenize(input)).parse();
}

function quoteIfNeeded(value: string, phrase: boolean): string {
  if (phrase || /\s/u.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

function precedence(ast: BooleanAst): number {
  if (ast.type === "or") return 1;
  if (ast.type === "and") return 2;
  if (ast.type === "not") return 3;
  return 4;
}

function render(ast: BooleanAst, parentPrecedence = 0): string {
  const current = precedence(ast);
  let value: string;
  if (ast.type === "term") value = quoteIfNeeded(ast.value, ast.phrase);
  else if (ast.type === "not") value = `NOT ${render(ast.child, current)}`;
  else value = ast.children.map((child) => render(child, current)).join(ast.type === "and" ? " AND " : " OR ");
  return current < parentPrecedence ? `(${value})` : value;
}

export function normalizeBooleanQuery(input: string): string {
  return render(parseBooleanQuery(input));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function evaluateBooleanAst(ast: BooleanAst, content: string): boolean {
  const haystack = normalizeText(content);
  const visit = (node: BooleanAst): boolean => {
    if (node.type === "term") return haystack.includes(normalizeText(node.value));
    if (node.type === "not") return !visit(node.child);
    if (node.type === "and") return node.children.every(visit);
    return node.children.some(visit);
  };
  return visit(ast);
}

export interface ProviderQueryCompiler {
  readonly providerId: string;
  compile(ast: BooleanAst): string[];
}

export class GenericBooleanCompiler implements ProviderQueryCompiler {
  readonly providerId = "generic";
  compile(ast: BooleanAst): string[] {
    return [render(ast)];
  }
}
