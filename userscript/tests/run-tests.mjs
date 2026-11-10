// ---------------------------------------------------------------------------
// run-tests.mjs —— 单进程运行全部测试
// 说明：`node --test` 会为每个文件 spawn 子进程，在受限沙箱里会 EPERM；
// 因此改为在同进程内 import 全部用例，由内置 test runner 汇总。
// ---------------------------------------------------------------------------
import './state.test.mjs';
import './config.test.mjs';
import './video.test.mjs';
import './course-tree.test.mjs';
import './integration.test.mjs';
import './url.test.mjs';
import './pause.test.mjs';
import './runner-regression.test.mjs';
import './quiz.test.mjs';
import './quiz-runner.test.mjs';
import './chapter-quiz.test.mjs';
