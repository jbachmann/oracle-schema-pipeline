import { qualifiedName, type SynonymDefinition } from './model.js';
export function renderSynonym(synonym: SynonymDefinition): string {
  return `CREATE ${synonym.editionable ? 'EDITIONABLE' : 'NONEDITIONABLE'} SYNONYM ${qualifiedName(synonym.reference)} FOR ${qualifiedName(synonym.target)};`;
}
