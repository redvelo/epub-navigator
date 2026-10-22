import { installNestedPublicationProjection } from "./content-agent/nested-publication.js";
import { installPrefixedCssMapping } from "./content-agent/prefixed-css.js";
import { bootstrapContentAgent } from "./content-agent/runtime.js";

installNestedPublicationProjection();
installPrefixedCssMapping();
bootstrapContentAgent();
