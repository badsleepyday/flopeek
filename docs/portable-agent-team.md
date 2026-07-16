# Portable SDLC agent-team adoption

Flowpeek is the first project-specific adopter of the standalone `portable-sdlc-agent-team` baseline. The standalone repository owns generic role domains, evidence rules, onboarding semantics, artifact contracts, release gates, and a dependency-free installer. Flowpeek owns the specialized prompts and schemas required to review generated technical flows, Context Refs, graph versions, parser facts, MCP parity, and local-first evidence boundaries.

## Relationship

```text
portable-sdlc-agent-team
  generic roles, contracts, installer, project onboarding
                |
                | specialized adapter
                v
Flowpeek
  Flow Lens roles, Context Ref identity, graph evidence, product gates
```

Flowpeek does not depend on a mutable global installation at runtime. Its specialized skills remain committed under `.agents/skills/`, and `.agent-team/upstream.json` records the portable baseline version and deterministic role mapping. This makes the exact prompts reviewable with the same commit as the product.

## Synchronization rules

1. Generic improvements are made in `portable-sdlc-agent-team` without Flowpeek-only terminology.
2. Flowpeek adopts relevant changes by updating its specialized skill, schema, protocol, mapping version, and contract test together.
3. Flowpeek-specific evidence types or workflow rules remain in Flowpeek unless evidence from multiple unrelated projects justifies an upstream contract.
4. Reinstalling the generic team into Flowpeek is not an upgrade mechanism because it would create parallel generic skills beside specialized ones.
5. Fara may create a Flowpeek-local role for a recurring high-relevance Flowpeek gap. A cross-project role requires an upstream proposal and evidence from more than one adopter.

The standalone role name never establishes source truth or provider independence. Flowpeek continues to require current graph identity, direct evidence, explicit unknowns, and actual provider provenance.
