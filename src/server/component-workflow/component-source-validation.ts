import ts from "typescript"

const COPPER_PAD_ELEMENTS = new Set(["smtpad", "platedhole"])

function jsxTagName(node: ts.JsxOpeningLikeElement, source_file: ts.SourceFile): string {
  return node.tagName.getText(source_file).toLowerCase()
}

function hasJsxAttribute(node: ts.JsxOpeningLikeElement, attribute_name: string): boolean {
  return node.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === attribute_name,
  )
}

/**
 * Component footprints must be expressed through tscircuit's JSX primitives.
 * Raw circuit-json-like pad arrays are accepted by TypeScript but bypass the
 * JSX parent/port resolution which binds copper pads to chip ports.
 */
export function getComponentSourceStructureErrors(source: string): string[] {
  const source_file = ts.createSourceFile(
    "index.circuit.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let footprint_count = 0
  let copper_pad_count = 0
  let unbound_copper_pad_count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag_name = jsxTagName(node, source_file)
      if (tag_name === "footprint") footprint_count += 1
      if (COPPER_PAD_ELEMENTS.has(tag_name)) {
        copper_pad_count += 1
        if (!hasJsxAttribute(node, "portHints")) unbound_copper_pad_count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)

  const errors: string[] = []
  if (footprint_count === 0 || copper_pad_count === 0) {
    errors.push(
      "Component source must render its supplied pad plans through a <footprint> containing <smtpad> or <platedhole> JSX elements; passing raw pad arrays to the chip footprint prop does not bind pads to ports",
    )
  }
  if (unbound_copper_pad_count > 0) {
    errors.push(
      `Component source contains ${unbound_copper_pad_count} copper pad JSX element(s) without portHints`,
    )
  }
  return errors
}
