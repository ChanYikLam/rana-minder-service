-- ============================================================
-- RanaMinder 联调种子：组织端授权真实数据（A4 权限接线）
-- 目标库：ranaminder_wt44（联调库；idempotent，可重复执行）
--
-- 内容：
--   1. 三个内置权限模板（负责人/人事/部门负责人，published）
--   2. club-demo 的 club/position Group 映射（org_group_mapping）
--   3. 负责人职位 → 社团负责人模板绑定（org_position_template_binding）
--   4. admin 主体 → club-demo 负责人职位关系观测（org_member_group_current）
--
-- 效果：admin 登录后会话 workspace = 极客俱乐部（club_leader），
--       permissions 含 club:member:manage 等，组织端/管理端可访问。
--
-- ⚠️ subject_id 必须与 users.subject_id / Casdoor id_token.sub 一致。
--    执行前先核对：SELECT subject_id FROM users;（联调种子 admin 的
--    subject_id 为 'ranaminder-dev__admin__fixed'，如不同请替换下方两处）
-- ============================================================

-- 1) 内置权限模板（published；payload 结构与 PermissionTemplateStore.save 一致）
INSERT INTO org_permission_template (id, payload) VALUES
('ptpl-builtin-leader', '{
  "id": "ptpl-builtin-leader",
  "name": "社团负责人",
  "scopeClass": "club",
  "draft": null,
  "published": {
    "version": 1,
    "name": "社团负责人",
    "permissions": [
      "club:recruitment:manage", "club:joint:manage", "club:member:manage",
      "club:member:manage:full", "club:appointment:manage", "club:resignation:approve",
      "club:batch:execute", "club:transition:manage", "club:invite:manage",
      "club:export:execute", "club:config:manage", "club:interview:view",
      "club:interview:evaluate", "club:audit:view"
    ]
  }
}'),
('ptpl-builtin-personnel', '{
  "id": "ptpl-builtin-personnel",
  "name": "人事管理员",
  "scopeClass": "club",
  "draft": null,
  "published": {
    "version": 1,
    "name": "人事管理员",
    "permissions": [
      "club:member:manage", "club:appointment:manage", "club:transition:manage",
      "club:invite:manage", "club:interview:view", "club:interview:evaluate",
      "club:audit:view"
    ]
  }
}'),
('ptpl-builtin-dept-head', '{
  "id": "ptpl-builtin-dept-head",
  "name": "部门负责人",
  "scopeClass": "department",
  "draft": null,
  "published": {
    "version": 1,
    "name": "部门负责人",
    "permissions": [
      "club:member:manage", "club:interview:view", "club:interview:evaluate"
    ]
  }
}')
ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload;

-- 2) Group 映射：club-demo 的社团 Group 与负责人职位 Group（联调 Casdoor 种子组名）
INSERT INTO org_group_mapping (group_owner, group_name, club_id, purpose, department_id, position_id, mapping_version) VALUES
('club-demo', 'club-demo', 'club-demo', 'club', NULL, NULL, 1),
('club-demo', '负责人', 'club-demo', 'position', NULL, 'pos-leader-demo', 1)
ON CONFLICT (group_owner, group_name) DO UPDATE
SET club_id = EXCLUDED.club_id, purpose = EXCLUDED.purpose,
    department_id = EXCLUDED.department_id, position_id = EXCLUDED.position_id,
    mapping_version = org_group_mapping.mapping_version + 1;

-- 3) 负责人职位绑定 → 社团负责人模板（published v1）
INSERT INTO org_position_template_binding (position_owner, position_name, club_id, payload) VALUES
('club-demo', '负责人', 'club-demo', '{
  "positionGroup": { "owner": "club-demo", "name": "负责人" },
  "clubId": "club-demo",
  "templateId": "ptpl-builtin-leader",
  "templateVersion": 1
}')
ON CONFLICT (position_owner, position_name) DO UPDATE SET payload = EXCLUDED.payload;

-- 4) admin 主体 → club-demo 负责人（Club + Position 两条关系观测）
INSERT INTO org_member_group_current (subject_id, group_owner, group_name, club_id, department_id, purpose, observed_at) VALUES
('ranaminder-dev__admin__fixed', 'club-demo', 'club-demo', 'club-demo', NULL, 'club', now()),
('ranaminder-dev__admin__fixed', 'club-demo', '负责人', 'club-demo', NULL, 'position', now())
ON CONFLICT (subject_id, group_owner, group_name) DO UPDATE
SET club_id = EXCLUDED.club_id, purpose = EXCLUDED.purpose,
    department_id = EXCLUDED.department_id, observed_at = now();
