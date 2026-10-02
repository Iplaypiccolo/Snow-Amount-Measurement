-- (선택) 접속·수정 기록을 DB 차원에서도 고치거나 지울 수 없게 막는 규칙(트리거)
-- schema.sql 을 먼저 실행한 뒤 실행하세요. D1 에서 트리거를 지원하지 않으면 오류가 날 수 있으며, 그래도 앱은 동작합니다.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
