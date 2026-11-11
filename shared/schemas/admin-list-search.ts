/**
 * The longest search the admin list routes accept (Projects, Devices). The
 * route schemas and the search boxes read this one number, so a pasted search
 * can never be one the page sends and the route then refuses.
 */
export const ADMIN_LIST_SEARCH_MAX = 120
