/*
 * OAuth 2.0 Protected Resource Metadata — RFC 9728 (catch-all path).
 * Handles path-aware discovery, e.g. /.well-known/oauth-protected-resource/api/v1/mcp
 */
import { defineEventHandler } from 'h3'
import { handleProtectedResourceMetadata } from './handler'

export default defineEventHandler((event) => handleProtectedResourceMetadata(event))
