export class ComponentNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ComponentNotReadyError"
  }
}
