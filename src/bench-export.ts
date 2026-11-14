// ProbeBench, declared with no body yet: an exports change reaches 100% alone (docs/continuous-deployment.md "Exports
// changes"), so the version that adds the probe workbench (src/bench) ramps with identical exports.
import { DurableObject } from 'cloudflare:workers';

export class ProbeBench extends DurableObject {}
