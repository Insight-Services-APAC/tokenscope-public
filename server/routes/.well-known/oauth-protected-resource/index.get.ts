/*
 * OAuth 2.0 Protected Resource Metadata — RFC 9728 (root path).
 * In Nitro production builds the [...].ts catch-all only matches subpaths, so
 * this index handler ensures the bare path resolves too.
 */
import { defineEventHandler } from 'h3'
import { handleProtectedResourceMetadata } from './handler'

export default defineEventHandler((event) => handleProtectedResourceMetadata(event))
