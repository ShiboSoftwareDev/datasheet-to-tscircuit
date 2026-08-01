/** Stable compatibility facade for immutable model publication bundles. */
export { readVerifiedPublicationArtifact } from "./model-publication/artifact-reader"
export { writePublicationBundleManifest } from "./model-publication/bundle-manifest"
export {
  commitModelPublication,
  resolveAcceptedModelPublication,
} from "./model-publication/commit"
export {
  FRESH_MODEL_PUBLICATION_POLICY,
  MODEL_PUBLICATION_FILE,
} from "./model-publication/constants"
export {
  readModelPublication,
  validateResolvedModelPublication,
} from "./model-publication/reader"
export type {
  ModelPublicationBundle,
  ModelPublicationCommit,
  ModelPublicationPolicy,
  ModelPublicationRecord,
  PublicationBundleManifest,
  ResolvedModelPublication,
} from "./model-publication/types"
