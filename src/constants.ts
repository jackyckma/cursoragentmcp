export const CURSOR_API_BASE_URL = "https://api.cursor.com";
export const CHARACTER_LIMIT = 25000;

// Cursor's own documented limits — kept here so tool schemas and
// error messages stay in sync with the API instead of drifting.
export const MAX_REPOS_PER_AGENT = 20;
export const MAX_IMAGES_PER_PROMPT = 5;
export const REPOSITORIES_ENDPOINT_NOTE =
  "GET /v1/repositories is rate-limited by Cursor to 1 request/user/minute and 30/hour, and can take tens of seconds to respond. Call it sparingly — prefer asking the user for the repo URL directly when it's already known.";
