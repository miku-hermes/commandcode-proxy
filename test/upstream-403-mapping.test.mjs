import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const PLAN_MESSAGE = 'MODEL_NOT_IN_PLAN: Claude Sonnet 4.6 available in Pro and above plans';
const CASES = [
  {
    name: 'MODEL_NOT_IN_PLAN → 403 permission_error',
    upstreamStatus: 403,
    error: { code: 'MODEL_NOT_IN_PLAN', message: PLAN_MESSAGE },
    expectedStatus: 403, expectedType: 'permission_error',
  },
  {
    name: '普通 403（无 code，即使 message 含 MODEL_NOT_IN_PLAN）→ 仍 401',
    upstreamStatus: 403,
    error: { message: PLAN_MESSAGE },
    expectedStatus: 401, expectedType: 'authentication_error',
  },
  {
    name: '普通 403（code = INVALID_API_KEY）→ 仍 401',
    upstreamStatus: 403,
    error: { code: 'INVALID_API_KEY', message: 'Invalid API key' },
    expectedStatus: 401, expectedType: 'authentication_error',
  },
  {
    name: '/v1/messages：MODEL_NOT_IN_PLAN → 403 permission_error',
    upstreamStatus: 403, anthropic: true, stream: false,
    error: { code: 'MODEL_NOT_IN_PLAN', message: PLAN_MESSAGE },
    expectedStatus: 403, expectedType: 'permission_error',
  },
  {
    name: '401（即使 code = MODEL_NOT_IN_PLAN）→ 仍 401 authentication_error',
    upstreamStatus: 401,
    error: { code: 'MODEL_NOT_IN_PLAN', message: PLAN_MESSAGE },
    expectedStatus: 401, expectedType: 'authentication_error',
  },
  {
    name: '403 小写 model_not_in_plan → 403 permission_error',
    upstreamStatus: 403, stream: false,
    error: { code: 'model_not_in_plan', message: 'Model is not included in this plan' },
    expectedStatus: 403, expectedType: 'permission_error',
  },
  {
    name: '403 混合大小写 Permission_Denied → 403 permission_error',
    upstreamStatus: 403,
    error: { code: 'Permission_Denied', message: 'Permission denied for this model' },
    expectedStatus: 403, expectedType: 'permission_error',
  },
  {
    name: '403 顶层 code = FoRbIdDeN → 403 permission_error',
    upstreamStatus: 403, topLevel: true,
    error: { code: 'FoRbIdDeN', message: 'Forbidden model' },
    expectedStatus: 403, expectedType: 'permission_error',
  },
];

for (const testCase of CASES) {
  test(testCase.name, async () => {
    const fixture = await setup({
      status: testCase.upstreamStatus,
      errorBody: JSON.stringify(testCase.topLevel ? testCase.error : { error: testCase.error }),
    });
    try {
      const response = await fixture.proxy.post(
        testCase.anthropic ? '/v1/messages' : '/v1/chat/completions',
        {
          model: 'anthropic/claude-sonnet-4.6',
          max_tokens: 100,
          stream: testCase.stream ?? true,
          messages: [{ role: 'user', content: 'hi' }],
        },
        testCase.anthropic ? { 'x-api-key': 'user_test' } : { Authorization: 'Bearer user_test' },
      );
      const body = await response.json();
      assert.equal(response.status, testCase.expectedStatus);
      assert.equal(body.error.type, testCase.expectedType);
      assert.equal(body.error.message, testCase.error.message);
      assert.equal(fixture.mock.generateCount(), 1);
      if (testCase.anthropic) {
        assert.equal(body.type, 'error');
      } else {
        assert.equal(body.error.code, testCase.error.code);
      }
      if (testCase.error.code === 'MODEL_NOT_IN_PLAN') {
        assert.match(JSON.stringify(body), /MODEL_NOT_IN_PLAN/);
      }
    } finally { await fixture.close(); }
  });
}
