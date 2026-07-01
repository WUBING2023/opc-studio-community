// .github/scripts/review.mjs — OPC 社区自动审查程序。
// 在 pull_request_target 下运行:校验 schema + **所有权**(只能改/删自己的)+ 只允许动内容目录 → 自动合并或拒绝。
// 安全:只通过 API 读取 PR 的模板 JSON 数据,**绝不执行 PR 提供的代码**。
const token = process.env.GH_TOKEN;
const [owner, repo] = (process.env.REPO || "").split("/");
const prNumber = process.env.PR_NUMBER;
const prAuthor = (process.env.PR_AUTHOR || "").toLowerCase();
const headSha = process.env.HEAD_SHA;
const baseSha = process.env.BASE_SHA;
const API = "https://api.github.com";
const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "OPC-Review", "X-GitHub-Api-Version": "2022-11-28" };

const CONTENT_DIRS = ["templates/", "agents/", "prompts/"];
const SAFE_ID = /^[a-zA-Z0-9_.-]{1,64}$/;

async function gh(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok && r.status !== 404) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 404 ? null : r.json();
}
async function raw(path, ref) {
  const r = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`, { headers: { ...H, Accept: "application/vnd.github.raw+json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`raw ${path}: ${r.status}`);
  return r.text();
}
const comment = (body) => gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
async function reject(reason) {
  await comment(`❌ 自动审查未通过:${reason}\n\n本 PR 已自动关闭;修正后可重新提交。`);
  await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  console.log("REJECTED:", reason);
}
async function approveMerge() {
  await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
  await comment("✅ 自动审查通过(schema + 所有权 + 安全目录),已自动合并。感谢分享!");
  console.log("MERGED");
}

function validate(obj) {
  if (!obj || typeof obj !== "object") return "不是合法 JSON 对象";
  if (!obj.id || !SAFE_ID.test(String(obj.id))) return "缺少合法 id(^[A-Za-z0-9_.-]{1,64}$)";
  if (!obj.title && !obj.name) return "缺少 title/name";
  if (!obj.author) return "缺少 author(必须是你的 GitHub 用户名)";
  return null;
}

async function main() {
  const files = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  if (!files || !files.length) return reject("没有改动文件");

  for (const f of files) {
    const p = f.filename;
    if (!CONTENT_DIRS.some((d) => p.startsWith(d))) return reject(`不允许修改 \`${p}\`——只能提交 templates/ · agents/ · prompts/ 下的 .json`);
    if (!p.endsWith(".json")) return reject(`\`${p}\` 不是 .json`);

    if (f.status === "removed") {
      const base = await raw(p, baseSha);
      if (base == null) return reject(`要删的 \`${p}\` 在基线不存在`);
      let bj; try { bj = JSON.parse(base); } catch { return reject(`\`${p}\` 基线 JSON 损坏`); }
      if (String(bj.author || "").toLowerCase() !== prAuthor) return reject(`不能删除别人的内容(\`${p}\` 属于 @${bj.author})`);
      continue;
    }

    // added / modified:校验 PR head 内容
    const head = await raw(p, headSha);
    if (head == null) return reject(`读不到 \`${p}\` 内容`);
    let hj; try { hj = JSON.parse(head); } catch { return reject(`\`${p}\` 不是合法 JSON`); }
    const verr = validate(hj);
    if (verr) return reject(`\`${p}\`:${verr}`);
    if (String(hj.author).toLowerCase() !== prAuthor) return reject(`\`${p}\` 的 author(@${hj.author})必须是你自己(@${process.env.PR_AUTHOR}),不能冒名`);
    const baseName = p.split("/").pop().replace(/\.json$/, "");
    if (baseName !== String(hj.id)) return reject(`文件名(${baseName})必须等于 id(${hj.id})`);

    if (f.status === "modified") { // 改的若是已存在文件,基线 author 也必须是你
      const base = await raw(p, baseSha);
      if (base != null) { let bj; try { bj = JSON.parse(base); } catch { bj = {}; } if (bj.author && String(bj.author).toLowerCase() !== prAuthor) return reject(`不能修改别人的内容(\`${p}\` 属于 @${bj.author})`); }
    }
  }
  await approveMerge();
}
main().catch(async (e) => { try { await comment("⚠️ 自动审查脚本异常:" + e.message + "(请人工查看)"); } catch { /* */ } console.error(e); process.exit(1); });
