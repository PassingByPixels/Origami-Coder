// Resolvable stub for the `vscode` bare specifier so vitest can import
// extension-host modules (src/) in jsdom. Real behaviour is supplied
// per-test via `vi.mock('vscode', factory)`; this module just exists so
// vite's import-analysis can resolve the specifier before mocking. Any
// test that touches a member it didn't mock gets `undefined` and should
// mock that member explicitly.
export {};
