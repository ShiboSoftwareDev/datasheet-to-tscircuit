import ts from "typescript"

export interface ExpectedApplicationConnection {
  net: string
  pins: string[]
}

export interface ApplicationConnectivityPlan {
  components: Array<{
    reference: string
    kind?: string
    value?: string
    manufacturer_part_number?: string
    footprint?: string
  }>
  connections: ExpectedApplicationConnection[]
}

const COMPONENT_MODULE_PATTERN = /^\.\/index\.circuit(?:\.tsx)?$/

function getValidatedComponentInstantiationErrors(source_file: ts.SourceFile): string[] {
  const component_imports = source_file.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !COMPONENT_MODULE_PATTERN.test(statement.moduleSpecifier.text)
    ) {
      return []
    }
    const default_import = statement.importClause?.name
    return default_import ? [default_import.text] : []
  })
  if (component_imports.length !== 1) {
    return ["Typical application must have exactly one default import from ./index.circuit"]
  }

  const component_binding = component_imports[0] ?? ""
  let component_instances = 0
  let u1_instances = 0
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(source_file) === component_binding) {
        component_instances += 1
        const name = getLiteralJsxAttribute(node, "name")
        if (name?.trim().toLowerCase() === "u1") u1_instances += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return component_instances === 1 && u1_instances === 1
    ? []
    : [
        `Typical application must instantiate the default import ${component_binding} from ./index.circuit exactly once with literal name="U1"`,
      ]
}

export function getTypicalApplicationSourceErrors(
  source: string,
  pcb_implementation: "verified" | "schematic_only" = "verified",
  plan?: ApplicationConnectivityPlan,
): string[] {
  const errors: string[] = []
  if (/<\s*netlabel\b/i.test(source)) {
    errors.push("Typical application source must not instantiate <netlabel> elements")
  }
  if (pcb_implementation === "schematic_only" && /\bfootprint\s*=/.test(source)) {
    errors.push("Schematic-only typical application source must not assign PCB footprints")
  }
  if (pcb_implementation === "schematic_only" && /\bpcb(?:X|Y|Rotation|Layer)\s*=/.test(source)) {
    errors.push("Schematic-only typical application source must not assign PCB placement props")
  }
  if (plan) {
    const source_file = ts.createSourceFile(
      "typical-application.circuit.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    errors.push(...getValidatedComponentInstantiationErrors(source_file))
    const component_props = getLiteralJsxComponentProps(source)
    for (const component of plan.components) {
      if (component.reference.trim().toLowerCase() === "u1") continue
      const requires_part_number = Boolean(component.manufacturer_part_number)
      if (pcb_implementation !== "verified" && !requires_part_number) continue
      const props = component_props.get(component.reference.trim().toLowerCase())
      if (!props) {
        errors.push(
          pcb_implementation === "verified"
            ? `Verified PCB component ${component.reference} must be instantiated with a literal name prop`
            : `Application component ${component.reference} with a recorded manufacturer part number must be instantiated with a literal name prop`,
        )
        continue
      }
      if (
        component.manufacturer_part_number &&
        props.manufacturerPartNumber !== component.manufacturer_part_number
      ) {
        errors.push(
          pcb_implementation === "verified"
            ? `Verified PCB component ${component.reference} must set literal manufacturerPartNumber=${JSON.stringify(component.manufacturer_part_number)}`
            : `Application component ${component.reference} must set literal manufacturerPartNumber=${JSON.stringify(component.manufacturer_part_number)}`,
        )
      }
      if (
        pcb_implementation === "verified" &&
        component.footprint &&
        props.footprint !== component.footprint
      ) {
        errors.push(
          `Verified PCB component ${component.reference} must set literal footprint=${JSON.stringify(component.footprint)}`,
        )
      }
    }
  }
  return errors
}

function getLiteralJsxAttribute(node: ts.JsxOpeningLikeElement, attribute_name: string): string | undefined {
  const attribute = node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === attribute_name,
  )
  const initializer = attribute?.initializer
  if (!initializer) return undefined
  if (ts.isStringLiteral(initializer)) return initializer.text
  const expression = ts.isJsxExpression(initializer) ? initializer.expression : undefined
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined
}

function getLiteralJsxComponentProps(source: string): Map<string, Record<string, string | undefined>> {
  const source_file = ts.createSourceFile(
    "typical-application.circuit.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const components = new Map<string, Record<string, string | undefined>>()
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = getLiteralJsxAttribute(node, "name")
      if (name) {
        components.set(name.trim().toLowerCase(), {
          manufacturerPartNumber: getLiteralJsxAttribute(node, "manufacturerPartNumber"),
          footprint: getLiteralJsxAttribute(node, "footprint"),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return components
}
