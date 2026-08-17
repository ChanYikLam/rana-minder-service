-- ============================================================
-- RanaMinder 开发环境 PostgreSQL 初始化脚本
-- 挂载于 docker-entrypoint-initdb.d，容器首次初始化时自动执行
-- 权威依据：docs/engineering/开发环境搭建指南-v1.0.md §2
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- uuidv7() 为 PostgreSQL 18 内置函数，无需扩展
-- 验证：SELECT uuidv7(), word_similarity('软件','软件协会');
