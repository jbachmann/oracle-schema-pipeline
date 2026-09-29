WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK
WHENEVER OSERROR EXIT FAILURE
SET SERVEROUTPUT ON
SET LINESIZE 200
SET PAGESIZE 100
ALTER SESSION SET CONTAINER=FREEPDB1;
SELECT version FROM product_component_version WHERE product LIKE 'Oracle%Database%';
CREATE USER "Program Probe" NO AUTHENTICATION;
CREATE PACKAGE "Program Probe".constants AS
  value CONSTANT VARCHAR2(10) := 'OPEN';
END;
/
CREATE PACKAGE "Program Probe".api AUTHID CURRENT_USER AS
  PROCEDURE noop;
  PROCEDURE overloaded(n NUMBER);
  PROCEDURE overloaded(n VARCHAR2);
  FUNCTION normalized(n VARCHAR2) RETURN VARCHAR2 DETERMINISTIC;
END;
/
CREATE PACKAGE BODY "Program Probe".api AS
  PROCEDURE noop IS BEGIN NULL; END;
  PROCEDURE overloaded(n NUMBER) IS BEGIN NULL; END;
  PROCEDURE overloaded(n VARCHAR2) IS BEGIN NULL; END;
  FUNCTION normalized(n VARCHAR2) RETURN VARCHAR2 DETERMINISTIC IS
  BEGIN RETURN UPPER(n); END;
END;
/
CREATE FUNCTION "Program Probe"."Mixed Name" RETURN NUMBER DETERMINISTIC AS
BEGIN
  RETURN 1;
END;
/
CREATE SEQUENCE "Program Probe".ascending_seq MINVALUE 1 MAXVALUE 9999999999999999999999999999 START WITH 500 CACHE 20 KEEP;
CREATE SEQUENCE "Program Probe".descending_seq MINVALUE -999 MAXVALUE -1 INCREMENT BY -2 START WITH -1 NOCACHE CYCLE NOORDER NOKEEP;
CREATE SYNONYM "Program Probe".seq_alias FOR "Program Probe".ascending_seq;
CREATE SYNONYM "Program Probe".alias_chain FOR "Program Probe".seq_alias;
CREATE FUNCTION "Program Probe".new_id RETURN NUMBER AS
BEGIN RETURN "Program Probe".alias_chain.NEXTVAL; END;
/
SELECT object_name, object_type, status, editionable, edition_name, sharing FROM dba_objects WHERE owner='Program Probe' ORDER BY object_name, object_type;
SELECT name, type, line, LENGTH(text) AS chars, ASCII(SUBSTR(text,-1)) AS last_char, text FROM dba_source WHERE owner='Program Probe' ORDER BY name,type,line;
SELECT object_name, procedure_name, subprogram_id, overload, object_type, authid, deterministic, result_cache, pipelined, parallel, aggregate, sql_macro, interface, polymorphic, impltypeowner FROM dba_procedures WHERE owner='Program Probe' ORDER BY object_name,subprogram_id;
SELECT object_name, package_name, subprogram_id, position, data_level FROM dba_arguments WHERE owner='Program Probe' ORDER BY package_name,object_name,subprogram_id,sequence;
SELECT name, type, referenced_owner, referenced_name, referenced_type FROM dba_dependencies WHERE owner='Program Probe' ORDER BY name,type,referenced_owner,referenced_name;
SELECT name,type,plsql_optimize_level,plsql_code_type,plsql_debug,plsql_warnings,nls_length_semantics,plsql_ccflags,plscope_settings,plsql_implicit_conversion_bool FROM dba_plsql_object_settings WHERE owner='Program Probe' ORDER BY name,type;
SELECT sequence_name, TO_CHAR(max_value,'FM99999999999999999999999999999999999999','NLS_NUMERIC_CHARACTERS=''.,''') AS max_value, cycle_flag,order_flag,cache_size,scale_flag,extend_flag,sharded_flag,session_flag,keep_value FROM dba_sequences WHERE sequence_owner='Program Probe';
DECLARE
  statement CLOB;
  cursor_id INTEGER;
  n INTEGER;
BEGIN
  DBMS_LOB.CREATETEMPORARY(statement,TRUE);
  DBMS_LOB.WRITEAPPEND(statement, LENGTH('CREATE PROCEDURE "Program Probe".large_unit AS /*'), 'CREATE PROCEDURE "Program Probe".large_unit AS /*');
  FOR i IN 1..40 LOOP
    DBMS_LOB.WRITEAPPEND(statement,1000,RPAD('x',1000,'x'));
  END LOOP;
  DBMS_LOB.WRITEAPPEND(statement,LENGTH('*/ BEGIN NULL; END;'),'*/ BEGIN NULL; END;');
  cursor_id := DBMS_SQL.OPEN_CURSOR;
  DBMS_SQL.PARSE(cursor_id,statement,DBMS_SQL.NATIVE);
  DBMS_SQL.CLOSE_CURSOR(cursor_id);
  DBMS_LOB.FREETEMPORARY(statement);
  SELECT COUNT(*) INTO n FROM dba_objects WHERE owner='Program Probe' AND object_name='LARGE_UNIT' AND status='VALID';
  IF n<>1 THEN RAISE_APPLICATION_ERROR(-20000,'CLOB_PARSE_FAILED'); END IF;
  DBMS_OUTPUT.PUT_LINE('CLOB_PARSE_OK');
END;
/
SELECT "Program Probe".descending_seq.NEXTVAL AS first_value FROM dual;
SELECT "Program Probe".descending_seq.NEXTVAL AS second_value FROM dual;
DROP USER "Program Probe" CASCADE;
EXIT
