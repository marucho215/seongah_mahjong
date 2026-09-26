/* GUI 스모크 테스트 전용 설정 (`npm run test:e2e`). 기본 `npm test`(전체 회귀)에는 포함되지 않는다.
 * 브라우저가 필요하다: 처음 한 번 `npx playwright install chromium`. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
