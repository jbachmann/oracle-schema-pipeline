-- Generated from oracle-schema-pipeline format 6. No source DDL was replayed.

WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK

WHENEVER OSERROR EXIT FAILURE ROLLBACK

SET DEFINE OFF

SET SQLBLANKLINES ON

SET ECHO ON

ALTER SESSION SET DEFERRED_SEGMENT_CREATION=TRUE;

DECLARE
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO n FROM ALL_USERS WHERE USERNAME = 'APP';
  IF n = 0 THEN
    EXECUTE IMMEDIATE 'CREATE USER "APP" NO AUTHENTICATION DEFAULT TABLESPACE "USERS" QUOTA UNLIMITED ON "USERS"';
  END IF;
END;
/

-- Phase 1: all tables, without foreign keys.

CREATE TABLE "APP"."CHILD" (
  "TENANT_ID" NUMBER(10,0),
  "ID" NUMBER(10,0)
) SEGMENT CREATION DEFERRED;

-- Phase 2: table and column comments.

BEGIN
  EXECUTE IMMEDIATE
    'COMMENT ON TABLE "APP"."CHILD" IS ''Synthetic child table''''s comment & ' ||
    UNISTR('\03A9') ||
    '''';
END;
/

COMMENT ON COLUMN "APP"."CHILD"."TENANT_ID" IS 'Tenant identifier';

-- Phase 3: standalone and constraint-supporting indexes, exactly once.

CREATE UNIQUE INDEX "APP"."PK_CHILD" ON "APP"."CHILD" ("TENANT_ID" ASC, "ID" ASC);

-- Phase 4: local constraints and candidate keys, reusing existing indexes.

ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "PK_CHILD" PRIMARY KEY ("TENANT_ID", "ID") NOT DEFERRABLE USING INDEX "APP"."PK_CHILD" ENABLE VALIDATE;

-- Phase 5: cross-schema REFERENCES grants.

-- Phase 6: selected target-origin foreign keys only.

-- Phase 7: conventional views.

PROMPT Schema reconstruction completed.
