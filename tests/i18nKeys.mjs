/**
    Los textos de la interfaz que hay que traducir: el primer argumento de
    tr(), L() y msg() en src/ (ver src/core/i18n.ts). Lo usan las pruebas para
    comprobar que ningún idioma se deja textos sin traducir.

    Es JavaScript (no TypeScript) porque usa node:fs y el compilador de
    TypeScript, que el proyecto no tiene tipados (tsconfig: "types": []).
*/
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** El texto de una cadena o de varias unidas con +; null si no es un literal. */
function literal(node) {
  if (ts.isStringLiteralLike(node))
    return node.text;

  if (ts.isParenthesizedExpression(node))
    return literal(node.expression);

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left), right = literal(node.right);
    return left !== null && right !== null ? left + right : null;
  }

  return null;
}

/** @returns {string[]} */
export function collectInterfaceTexts(directory) {
  const texts = new Set();

  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.parentPath.endsWith('lang'))
      continue;

    const path = join(entry.parentPath, entry.name);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);

    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && ['tr', 'L', 'msg'].includes(node.expression.text) && node.arguments.length > 0) {
        const text = literal(node.arguments[0]);

        if (text !== null)
          texts.add(text);
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return [...texts];
}
