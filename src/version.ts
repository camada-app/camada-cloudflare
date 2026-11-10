// Must equal package.json "version". Lives in src/ because the Update Camada action syncs only src/.
// Release rule: a release may change only src/ (customers' clones get nothing else).
// Anything else needs manual steps in the release notes.
export const VERSION = '0.1.0';
