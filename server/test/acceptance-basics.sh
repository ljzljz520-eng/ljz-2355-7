set -e
B=http://localhost:3000/api
J=/tmp/e2e
mkdir -p $J
jget(){ echo "=== $1"; }
pass(){ echo "  ✅ $1"; }
fail(){ echo "  ❌ $1"; exit 1; }

# 1) 创建实例 AX-210/A，锁旧手册
curl -s -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"E2E-1","model_code":"AX-210","hw_rev":"A","version_id":"mv-axa-10","migration_policy":"lock"}' > $J/inst.json
IID=$(python3 -c "import json;print(json.load(open('$J/inst.json'))['instance']['id'])")
echo "instance=$IID"
python3 - <<PY
import json
d=json.load(open('$J/inst.json'))
assert d['instance']['manual_version']=='1.0.0'
codes=[(s['code'],s['run_state'],s['applicability']) for s in d['steps']]
assert ('S10','active','applicable') in codes
assert ('S20','blocked','applicable') in codes   # S10 未完成
assert ('S40','blocked_unknown','unknown') in codes
assert ('S30','blocked_unknown','unknown') in codes  # rack_unit 未知 => 适用性未知
open('$J/iid','w').write(d['instance']['id'])
print("  创建后：S10 可勾选，S20 被 DAG 阻塞，S30/S40 因条件未知 blocked_unknown")
PY
pass "创建并钉住 1.0.0；未知条件阻塞，不能提前勾选"

# 2) 未答条件时尝试直接完成 S30（应 409）
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/instances/$IID/steps/st-a10-S30/complete -H 'Content-Type: application/json' -d '{"photos":[]}')
[ "$code" = "409" ] && pass "未满足前置/未知条件勾选被拒: $(python3 -c "import json;print(json.load(open('/tmp/r.json'))['error'])")" || fail "expected 409 got $code"

# 3) 尝试猜选不存在型号
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/instances -H 'Content-Type: application/json' -d '{"label":"x","model_code":"AX-220","hw_rev":"A"}')
[ "$code" = "404" ] && pass "未知/相近型号被拒（不默认选相近）: $(python3 -c "import json;print(json.load(open('/tmp/r.json'))['error'])")" || fail "got $code"

# 4) 完成 S10（需要照片）-> 无照片应 422；上传照片后完成
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/instances/$IID/steps/st-a10-S10/complete -H 'Content-Type: application/json' -d '{}')
[ "$code" = "422" ] && pass "S10 缺照片凭证被拒 422" || fail "got $code"
printf 'PSEUDO-PNG-nameplate' > /tmp/nameplate.bin
up=$(curl -s -X POST $B/instances/$IID/evidence -F file=@/tmp/nameplate.bin)
sha=$(echo "$up" | python3 -c "import json,sys;print(json.load(sys.stdin)['content_sha'])")
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/instances/$IID/steps/st-a10-S10/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"evidence/x\",\"content_sha\":\"$sha\"}]}")
[ "$code" = "200" ] && pass "S10 上传照片并完成（凭证绑定实例步骤）" || cat /tmp/r.json

# 5) 重复勾选 S10
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST $B/instances/$IID/steps/st-a10-S10/complete -H 'Content-Type: application/json' -d "{\"photos\":[{\"object_key\":\"x\",\"content_sha\":\"$sha\"}]}")
[ "$code" = "409" ] && pass "重复勾选被幂等拒绝: $(python3 -c "import json;print(json.load(open('/tmp/r.json'))['error'])")" || fail "got $code"

echo "PHASE1_OK"
