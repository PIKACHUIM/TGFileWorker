-- 为 sources 表添加 scan_mode 列
-- scan_mode 值：auto（默认，自动选择）、simple_bot_api、bot_api、mtproto
ALTER TABLE sources ADD COLUMN scan_mode TEXT CHECK(scan_mode IS NULL OR scan_mode IN ('auto','simple_bot_api','bot_api','mtproto'));
