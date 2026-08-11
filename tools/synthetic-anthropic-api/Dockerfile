# synthetic-anthropic-api — mock endpoint mimicking Anthropic's
# /v1/organizations/usage_report/claude_code shape per RN-15.
# Real API: https://docs.anthropic.com/en/api/admin-api/usage-cost/get-claude-code-usage-report
# Non-root user per CWE-732 hygiene; dev-only stub.
FROM node:24-slim
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --create-home app \
 && chown -R app:app /app
COPY --chown=app:app package.json server.js seed.json ./
USER app
EXPOSE 8080
CMD ["node", "server.js"]
