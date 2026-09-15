-- Seed after 0001 and before 0002 to exercise every identity_sessions dependency.
-- 在 0001 后、0002 前写入数据，覆盖 identity_sessions 的全部依赖边。
INSERT INTO principals VALUES('p1','human','active',randomblob(32),1000,1000,1000,NULL);
INSERT INTO human_profiles VALUES('p1','Klee',NULL,'zh-CN',1000,1000);
INSERT INTO identifiers VALUES('i1','p1','username','klee','klee',1000,1000);
INSERT INTO authenticators VALUES('a1','p1',randomblob(32),randomblob(64),0,randomblob(16),'[]',0,0,'Key',1000,NULL,NULL);
INSERT INTO identity_sessions VALUES('s1',randomblob(32),'p1','a1',NULL,'passkey','["passkey"]','urn:test',1000,1000,2000,3000,NULL,NULL,NULL);
INSERT INTO identity_sessions VALUES('s2',randomblob(32),'p1','a1',NULL,'passkey','["passkey"]','urn:test',1001,1001,2001,3001,NULL,NULL,'s1');

INSERT INTO binding_providers VALUES(
    'github','https://github.com','GitHub','https://github.com/login/oauth/authorize',
    'https://github.com/login/oauth/access_token','https://api.github.com/meta',
    'client','openid',1,1,'enabled',1000,1000
);
INSERT INTO binding_transactions VALUES(
    'bt1','p1','github','s1',randomblob(32),randomblob(32),randomblob(12),1,
    randomblob(32),'https://identity.moesegfault.dev/callback',1,'pending',1000,2000,NULL,NULL
);

INSERT INTO oauth_clients VALUES('app','App','native','none','app.example',1,'enabled',1000,1000);
INSERT INTO oauth_authorization_transactions VALUES(
    'ot1','app','https://app.example/cb','code','openid offline_access','state-value',
    'nonce-value','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','S256',
    'p1','s1','authenticated',1000,2000,NULL
);
INSERT INTO oauth_authorization_codes VALUES(
    'oc1',randomblob(32),'ot1','app','p1','s1','https://app.example/cb',
    'openid offline_access','nonce-value','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'S256',1000,2000,NULL,NULL
);
INSERT INTO oauth_refresh_token_families VALUES(
    'rf1','app','p1','s1','openid offline_access','identity',1000,5000,NULL,NULL,NULL
);
INSERT INTO oauth_refresh_tokens VALUES(
    'rt2','rf1',randomblob(32),1,1100,4000,'active',NULL,NULL
);
INSERT INTO oauth_refresh_tokens VALUES(
    'rt1','rf1',randomblob(32),0,1000,4000,'rotated',1500,'rt2'
);
