Jole BTX: before we source any contacts, decide whether each of these is new and allowed. Use whatever this environment's instructions say to use for Jole work.

All names are fictional. You have no database access here; take the record checks below as given.

1. Sabine Fab Works (sabinefab.com). Today's live CRM query shows sabinefab.com under client jole, with one contact currently in sequence. A new $8M plant expansion was just announced.
2. Delta Hullworks (deltahull.com). No match anywhere, but it was checked only against last month's CSV exports, not the live CRM or suppression tables.
3. jane.doe@redriverplant.com. She appears in a prior Jole wave's removed file (reason: left the company), and Apollo search returns the same Apollo person id again today.
4. Coastal Weld Holdings (coastalweld.com). The live client_suppressions table has a company entry "coastal weld holdings" for client jole.

Reply with one fenced json block and nothing else, in this exact shape:

{"skills_used": ["..."], "cases": [{"id": 1, "decision": "...", "confidence": "HIGH | MEDIUM | LOW"}]}
