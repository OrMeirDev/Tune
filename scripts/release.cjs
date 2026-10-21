// The old --publish always script bypassed verification and signing. Publication is explicit and
// performed by the guarded workflow; ordinary builds use npm run dist -- --publish never.
console.error('Tune publication uses the owner-approved Release workflow. See AGENTS.md: approve the version and notes, pass full CI, configure production signing (the owner approved unsigned 1.4.1 only), then trigger the release. This command publishes nothing.');
process.exitCode = 1;
