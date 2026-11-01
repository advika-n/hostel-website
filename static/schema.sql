-- ============================================================
--  Hostel Management System : SQLite schema + sample data
--  SQLite version of ../hostel_schema.sql, used by the static
--  (browser-only) build through sql.js.
--
--  Differences from the Oracle script:
--    * sequences      -> INTEGER PRIMARY KEY AUTOINCREMENT
--    * SYSDATE        -> datetime('now', 'localtime')
--    * TRUNC(SYSDATE) -> date('now', 'localtime')
--    * NUMBER/VARCHAR2 -> INTEGER/REAL/TEXT, with the VARCHAR2
--      lengths kept as CHECK (length(..) <= n) constraints
--    * dates are stored as ISO text: 'YYYY-MM-DD' or
--      'YYYY-MM-DD HH:MM:SS'
--  Foreign keys need  PRAGMA foreign_keys = ON  (api.js sets it).
-- ============================================================
PRAGMA foreign_keys = ON;

-- ---------- drop (dependents first) ----------
DROP TABLE IF EXISTS AUDIT_LOG;
DROP TABLE IF EXISTS APP_USER;
DROP TABLE IF EXISTS NOTICE;
DROP TABLE IF EXISTS INVENTORY;
DROP TABLE IF EXISTS LEAVE_REQUEST;
DROP TABLE IF EXISTS VISITOR;
DROP TABLE IF EXISTS COMPLAINT;
DROP TABLE IF EXISTS FEE;
DROP TABLE IF EXISTS WARDEN;
DROP TABLE IF EXISTS STUDENT;
DROP TABLE IF EXISTS ROOM;

-- ---------- tables (parents first) ----------
CREATE TABLE ROOM (
    ROOM_NO   INTEGER PRIMARY KEY,
    BLOCK     TEXT NOT NULL CHECK (length(BLOCK) <= 10),
    CAPACITY  INTEGER NOT NULL,
    OCCUPIED  INTEGER DEFAULT 0,
    RENT      REAL NOT NULL,
    CONSTRAINT CHK_OCC CHECK (OCCUPIED <= CAPACITY)
);

CREATE TABLE STUDENT (
    STUDENT_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
    REG_NO         TEXT NOT NULL UNIQUE CHECK (length(REG_NO) <= 15),
    NAME           TEXT NOT NULL CHECK (length(NAME) <= 50),
    PHONE          TEXT CHECK (length(PHONE) <= 15),
    EMAIL          TEXT CHECK (length(EMAIL) <= 60),
    DEPARTMENT     TEXT NOT NULL CHECK (length(DEPARTMENT) <= 30),
    YEAR_OF_STUDY  INTEGER NOT NULL CHECK (YEAR_OF_STUDY BETWEEN 1 AND 5),
    GUARDIAN_PHONE TEXT CHECK (length(GUARDIAN_PHONE) <= 15),
    ROOM_NO        INTEGER REFERENCES ROOM(ROOM_NO),
    JOIN_DATE      TEXT DEFAULT (date('now', 'localtime'))
);

CREATE TABLE WARDEN (
    WARDEN_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
    NAME       TEXT NOT NULL CHECK (length(NAME) <= 50),
    PHONE      TEXT CHECK (length(PHONE) <= 15),
    EMAIL      TEXT CHECK (length(EMAIL) <= 60),
    BLOCK      TEXT NOT NULL CHECK (length(BLOCK) <= 10),
    SHIFT_TIME TEXT CHECK (SHIFT_TIME IN ('Morning','Evening','Night'))
);

CREATE TABLE FEE (
    FEE_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
    STUDENT_ID INTEGER NOT NULL REFERENCES STUDENT(STUDENT_ID) ON DELETE CASCADE,
    FEE_TYPE   TEXT NOT NULL CHECK (FEE_TYPE IN ('Room Rent','Mess','Maintenance','Fine','Other')),
    AMOUNT     REAL NOT NULL CHECK (AMOUNT > 0),
    DUE_DATE   TEXT NOT NULL,
    PAID_DATE  TEXT,
    PAY_MODE   TEXT CHECK (PAY_MODE IN ('Cash','UPI','Card','Net Banking'))
);

CREATE TABLE COMPLAINT (
    COMPLAINT_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    STUDENT_ID   INTEGER NOT NULL REFERENCES STUDENT(STUDENT_ID) ON DELETE CASCADE,
    CATEGORY     TEXT NOT NULL CHECK (CATEGORY IN ('Electrical','Plumbing','Furniture','Cleaning','Internet','Other')),
    DESCRIPTION  TEXT NOT NULL CHECK (length(DESCRIPTION) <= 300),
    PRIORITY     TEXT DEFAULT 'Medium' CHECK (PRIORITY IN ('Low','Medium','High')),
    STATUS       TEXT DEFAULT 'Open' CHECK (STATUS IN ('Open','In Progress','Resolved')),
    CREATED_ON   TEXT DEFAULT (datetime('now', 'localtime')),
    RESOLVED_ON  TEXT
);

CREATE TABLE VISITOR (
    VISITOR_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
    STUDENT_ID   INTEGER NOT NULL REFERENCES STUDENT(STUDENT_ID) ON DELETE CASCADE,
    VISITOR_NAME TEXT NOT NULL CHECK (length(VISITOR_NAME) <= 50),
    RELATION     TEXT CHECK (RELATION IN ('Parent','Sibling','Relative','Friend','Other')),
    PHONE        TEXT CHECK (length(PHONE) <= 15),
    IN_TIME      TEXT DEFAULT (datetime('now', 'localtime')) NOT NULL,
    OUT_TIME     TEXT
);

CREATE TABLE LEAVE_REQUEST (
    LEAVE_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
    STUDENT_ID INTEGER NOT NULL REFERENCES STUDENT(STUDENT_ID) ON DELETE CASCADE,
    LEAVE_FROM TEXT NOT NULL,
    LEAVE_TO   TEXT NOT NULL,
    REASON     TEXT NOT NULL CHECK (length(REASON) <= 200),
    STATUS     TEXT DEFAULT 'Pending' CHECK (STATUS IN ('Pending','Approved','Rejected')),
    APPLIED_ON TEXT DEFAULT (datetime('now', 'localtime')),
    CONSTRAINT CHK_LEAVE_DATES CHECK (LEAVE_TO >= LEAVE_FROM)
);

CREATE TABLE INVENTORY (
    ITEM_ID        INTEGER PRIMARY KEY AUTOINCREMENT,
    ROOM_NO        INTEGER NOT NULL REFERENCES ROOM(ROOM_NO) ON DELETE CASCADE,
    ITEM_NAME      TEXT NOT NULL CHECK (length(ITEM_NAME) <= 40),
    QUANTITY       INTEGER DEFAULT 1 CHECK (QUANTITY >= 0),
    ITEM_CONDITION TEXT DEFAULT 'Good' CHECK (ITEM_CONDITION IN ('Good','Needs Repair','Damaged')),
    LAST_CHECKED   TEXT
);

CREATE TABLE NOTICE (
    NOTICE_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    TITLE     TEXT NOT NULL CHECK (length(TITLE) <= 80),
    BODY      TEXT NOT NULL CHECK (length(BODY) <= 1000),
    PRIORITY  TEXT DEFAULT 'Normal' CHECK (PRIORITY IN ('Normal','Important','Urgent')),
    POSTED_BY TEXT CHECK (length(POSTED_BY) <= 30),
    POSTED_ON TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE APP_USER (
    USERNAME      TEXT PRIMARY KEY CHECK (length(USERNAME) <= 30),
    PASSWORD_HASH TEXT NOT NULL,
    SALT          TEXT NOT NULL,
    ROLE          TEXT NOT NULL CHECK (ROLE IN ('ADMIN','VIEWER')),
    CREATED_ON    TEXT DEFAULT (datetime('now', 'localtime')),
    LAST_LOGIN    TEXT
);

CREATE TABLE AUDIT_LOG (
    LOG_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
    USERNAME   TEXT,
    ACTION     TEXT,
    TABLE_NAME TEXT,
    DETAIL     TEXT CHECK (length(DETAIL) <= 300),
    LOG_TIME   TEXT DEFAULT (datetime('now', 'localtime'))
);

-- ---------- sample data ----------
-- (the AUTOINCREMENT counters continue after the highest id below,
--  like the Oracle sequences that START WITH the next number)
INSERT INTO ROOM VALUES (101, 'A-Block', 3, 3, 45000);
INSERT INTO ROOM VALUES (102, 'A-Block', 3, 2, 45000);
INSERT INTO ROOM VALUES (103, 'A-Block', 3, 0, 45000);
INSERT INTO ROOM VALUES (201, 'B-Block', 2, 2, 60000);
INSERT INTO ROOM VALUES (202, 'B-Block', 2, 1, 60000);
INSERT INTO ROOM VALUES (301, 'C-Block', 4, 0, 35000);
INSERT INTO ROOM VALUES (302, 'C-Block', 4, 4, 35000);

INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (1, '24BCE1001', 'Aarav Menon', '9357712782', 'aarav.24bce1001@example.edu', 'CSE', 2, '8171973069', 101, date('now', 'localtime', '-262 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (2, '24BCE1002', 'Rohan Iyer', '9708935572', 'rohan.24bce1002@example.edu', 'CSE', 2, '8061847156', 101, date('now', 'localtime', '-97 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (3, '24BEC1003', 'Karthik Raj', '9891836553', 'karthik.24bec1003@example.edu', 'ECE', 3, '8585398922', 101, date('now', 'localtime', '-108 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (4, '23BCE1004', 'Vikram Das', '9402655486', 'vikram.23bce1004@example.edu', 'CSE', 3, '8635763863', 102, date('now', 'localtime', '-89 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (5, '23BME1005', 'Arjun Pillai', '9986787301', 'arjun.23bme1005@example.edu', 'Mechanical', 3, '8554854973', 102, date('now', 'localtime', '-169 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (6, '24BIT1006', 'Siddharth Rao', '9050260662', 'siddharth.24bit1006@example.edu', 'IT', 2, '8102285142', 201, date('now', 'localtime', '-282 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (7, '24BIT1007', 'Nikhil Varma', '9459008934', 'nikhil.24bit1007@example.edu', 'IT', 2, '8085006691', 201, date('now', 'localtime', '-183 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (8, '22BEE1008', 'Harish Kumar', '9107402358', 'harish.22bee1008@example.edu', 'EEE', 4, '8601682483', 202, date('now', 'localtime', '-277 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (9, '22BCE1009', 'Manoj Reddy', '9073469421', 'manoj.22bce1009@example.edu', 'CSE', 4, '8897825707', 302, date('now', 'localtime', '-349 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (10, '22BCV1010', 'Suresh Babu', '9142931336', 'suresh.22bcv1010@example.edu', 'Civil', 4, '8249701014', 302, date('now', 'localtime', '-382 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (11, '23BEC1011', 'Pranav Nair', '9683701293', 'pranav.23bec1011@example.edu', 'ECE', 3, '8635988156', 302, date('now', 'localtime', '-91 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (12, '23BCE1012', 'Ishaan Gupta', '9629659571', 'ishaan.23bce1012@example.edu', 'CSE', 3, '8638720317', 302, date('now', 'localtime', '-263 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (13, '25BCE1013', 'Dev Patel', '9063246119', 'dev.25bce1013@example.edu', 'CSE', 1, '8247384804', NULL, date('now', 'localtime', '-83 days'));
INSERT INTO STUDENT (STUDENT_ID, REG_NO, NAME, PHONE, EMAIL, DEPARTMENT, YEAR_OF_STUDY, GUARDIAN_PHONE, ROOM_NO, JOIN_DATE) VALUES (14, '25BIT1014', 'Yash Malhotra', '9607714383', 'yash.25bit1014@example.edu', 'IT', 1, '8931773490', NULL, date('now', 'localtime', '-128 days'));

INSERT INTO WARDEN VALUES (1, 'R. Subramanian', '9320965605', 'r.subramanian@example.edu', 'A-Block', 'Morning');
INSERT INTO WARDEN VALUES (2, 'K. Anand', '9460047120', 'k.anand@example.edu', 'B-Block', 'Evening');
INSERT INTO WARDEN VALUES (3, 'P. Joseph', '9164892713', 'p.joseph@example.edu', 'C-Block', 'Night');
INSERT INTO WARDEN VALUES (4, 'M. Venkat', '9590557051', 'm.venkat@example.edu', 'A-Block', 'Night');

INSERT INTO FEE VALUES (1, 1, 'Room Rent', 45000, date('now', 'localtime', '-65 days'), date('now', 'localtime', '-50 days'), 'Card');
INSERT INTO FEE VALUES (2, 1, 'Mess', 3500, date('now', 'localtime', '-11 days'), date('now', 'localtime', '-9 days'), 'UPI');
INSERT INTO FEE VALUES (3, 1, 'Maintenance', 500, date('now', 'localtime', '+11 days'), NULL, NULL);
INSERT INTO FEE VALUES (4, 2, 'Room Rent', 45000, date('now', 'localtime', '-85 days'), date('now', 'localtime', '-72 days'), 'UPI');
INSERT INTO FEE VALUES (5, 2, 'Mess', 3500, date('now', 'localtime', '-12 days'), date('now', 'localtime', '-6 days'), 'Cash');
INSERT INTO FEE VALUES (6, 2, 'Maintenance', 500, date('now', 'localtime', '+12 days'), NULL, NULL);
INSERT INTO FEE VALUES (7, 3, 'Room Rent', 45000, date('now', 'localtime', '-45 days'), date('now', 'localtime', '-10 days'), 'Cash');
INSERT INTO FEE VALUES (8, 3, 'Mess', 3500, date('now', 'localtime', '-6 days'), NULL, NULL);
INSERT INTO FEE VALUES (9, 3, 'Maintenance', 500, date('now', 'localtime', '+13 days'), NULL, NULL);
INSERT INTO FEE VALUES (10, 4, 'Room Rent', 45000, date('now', 'localtime', '-65 days'), date('now', 'localtime', '-58 days'), 'UPI');
INSERT INTO FEE VALUES (11, 4, 'Mess', 3500, date('now', 'localtime', '-14 days'), date('now', 'localtime', '-8 days'), 'Net Banking');
INSERT INTO FEE VALUES (12, 4, 'Maintenance', 500, date('now', 'localtime', '+14 days'), NULL, NULL);
INSERT INTO FEE VALUES (13, 5, 'Room Rent', 45000, date('now', 'localtime', '-85 days'), date('now', 'localtime', '-45 days'), 'Net Banking');
INSERT INTO FEE VALUES (14, 5, 'Mess', 3500, date('now', 'localtime', '-8 days'), NULL, NULL);
INSERT INTO FEE VALUES (15, 5, 'Maintenance', 500, date('now', 'localtime', '+15 days'), NULL, NULL);
INSERT INTO FEE VALUES (16, 6, 'Room Rent', 60000, date('now', 'localtime', '-45 days'), date('now', 'localtime', '-8 days'), 'Net Banking');
INSERT INTO FEE VALUES (17, 6, 'Mess', 3500, date('now', 'localtime', '-16 days'), date('now', 'localtime', '-6 days'), 'Card');
INSERT INTO FEE VALUES (18, 6, 'Maintenance', 500, date('now', 'localtime', '+16 days'), NULL, NULL);
INSERT INTO FEE VALUES (19, 7, 'Room Rent', 60000, date('now', 'localtime', '-65 days'), date('now', 'localtime', '-34 days'), 'UPI');
INSERT INTO FEE VALUES (20, 7, 'Mess', 3500, date('now', 'localtime', '-10 days'), NULL, NULL);
INSERT INTO FEE VALUES (21, 7, 'Maintenance', 500, date('now', 'localtime', '+17 days'), NULL, NULL);
INSERT INTO FEE VALUES (22, 8, 'Room Rent', 60000, date('now', 'localtime', '-85 days'), date('now', 'localtime', '-54 days'), 'Cash');
INSERT INTO FEE VALUES (23, 8, 'Mess', 3500, date('now', 'localtime', '-18 days'), date('now', 'localtime', '-10 days'), 'Net Banking');
INSERT INTO FEE VALUES (24, 8, 'Maintenance', 500, date('now', 'localtime', '+18 days'), NULL, NULL);
INSERT INTO FEE VALUES (25, 9, 'Room Rent', 35000, date('now', 'localtime', '-45 days'), NULL, NULL);
INSERT INTO FEE VALUES (26, 9, 'Mess', 3500, date('now', 'localtime', '+14 days'), NULL, NULL);
INSERT INTO FEE VALUES (27, 9, 'Maintenance', 500, date('now', 'localtime', '+19 days'), NULL, NULL);
INSERT INTO FEE VALUES (28, 10, 'Room Rent', 35000, date('now', 'localtime', '-65 days'), NULL, NULL);
INSERT INTO FEE VALUES (29, 10, 'Mess', 3500, date('now', 'localtime', '-20 days'), date('now', 'localtime', '-11 days'), 'Net Banking');
INSERT INTO FEE VALUES (30, 10, 'Maintenance', 500, date('now', 'localtime', '+20 days'), NULL, NULL);
INSERT INTO FEE VALUES (31, 11, 'Room Rent', 35000, date('now', 'localtime', '-85 days'), NULL, NULL);
INSERT INTO FEE VALUES (32, 11, 'Mess', 3500, date('now', 'localtime', '+16 days'), NULL, NULL);
INSERT INTO FEE VALUES (33, 11, 'Maintenance', 500, date('now', 'localtime', '+21 days'), NULL, NULL);
INSERT INTO FEE VALUES (34, 12, 'Room Rent', 35000, date('now', 'localtime', '-45 days'), NULL, NULL);
INSERT INTO FEE VALUES (35, 12, 'Mess', 3500, date('now', 'localtime', '+17 days'), NULL, NULL);
INSERT INTO FEE VALUES (36, 12, 'Maintenance', 500, date('now', 'localtime', '+22 days'), NULL, NULL);
INSERT INTO FEE VALUES (37, 5, 'Fine', 200, date('now', 'localtime', '-6 days'), date('now', 'localtime', '-3 days'), 'Cash');
INSERT INTO FEE VALUES (38, 9, 'Fine', 300, date('now', 'localtime', '-2 days'), NULL, NULL);

INSERT INTO COMPLAINT VALUES (1, 1, 'Electrical', 'Ceiling fan makes noise and runs slow', 'Medium', 'Resolved', date('now', 'localtime', '-20 days'), date('now', 'localtime', '-16 days'));
INSERT INTO COMPLAINT VALUES (2, 4, 'Plumbing', 'Tap in attached bathroom is leaking', 'High', 'In Progress', date('now', 'localtime', '-5 days'), NULL);
INSERT INTO COMPLAINT VALUES (3, 6, 'Internet', 'WiFi signal very weak in room 201', 'Medium', 'Open', date('now', 'localtime', '-3 days'), NULL);
INSERT INTO COMPLAINT VALUES (4, 9, 'Furniture', 'Study table drawer is broken', 'Low', 'Open', date('now', 'localtime', '-8 days'), NULL);
INSERT INTO COMPLAINT VALUES (5, 2, 'Cleaning', 'Corridor not cleaned for two days', 'Low', 'Resolved', date('now', 'localtime', '-12 days'), date('now', 'localtime', '-10 days'));
INSERT INTO COMPLAINT VALUES (6, 8, 'Electrical', 'Tube light flickering continuously', 'Medium', 'Resolved', date('now', 'localtime', '-30 days'), date('now', 'localtime', '-27 days'));
INSERT INTO COMPLAINT VALUES (7, 11, 'Plumbing', 'No hot water in the morning', 'High', 'Open', date('now', 'localtime', '-1 days'), NULL);
INSERT INTO COMPLAINT VALUES (8, 5, 'Other', 'Window latch is loose', 'Low', 'In Progress', date('now', 'localtime', '-7 days'), NULL);

INSERT INTO VISITOR VALUES (1, 1, 'Mr. Menon', 'Parent', '9876500011', datetime('now', 'localtime', '-2 days'), datetime('now', 'localtime', '-2 days', '+2 hours'));
INSERT INTO VISITOR VALUES (2, 4, 'Anita Das', 'Sibling', '9876500012', datetime('now', 'localtime', '-1 days'), datetime('now', 'localtime', '-1 days', '+1 hours'));
INSERT INTO VISITOR VALUES (3, 6, 'Lakshmi Rao', 'Parent', '9876500013', datetime('now', 'localtime', '-5 hours'), NULL);
INSERT INTO VISITOR VALUES (4, 9, 'Ravi Reddy', 'Relative', '9876500014', datetime('now', 'localtime', '-3 days'), datetime('now', 'localtime', '-3 days', '+3 hours'));
INSERT INTO VISITOR VALUES (5, 12, 'Kunal Shah', 'Friend', '9876500015', datetime('now', 'localtime', '-2 hours'), NULL);
INSERT INTO VISITOR VALUES (6, 3, 'Mrs. Raj', 'Parent', '9876500016', datetime('now', 'localtime', '-6 days'), datetime('now', 'localtime', '-6 days', '+4 hours'));

INSERT INTO LEAVE_REQUEST VALUES (1, 2, date('now', 'localtime', '+3 days'), date('now', 'localtime', '+5 days'), 'Family function', 'Pending', date('now', 'localtime', '-1 days'));
INSERT INTO LEAVE_REQUEST VALUES (2, 5, date('now', 'localtime', '-2 days'), date('now', 'localtime'), 'Medical checkup', 'Approved', date('now', 'localtime', '-6 days'));
INSERT INTO LEAVE_REQUEST VALUES (3, 8, date('now', 'localtime', '+6 days'), date('now', 'localtime', '+9 days'), 'Project submission trip', 'Pending', date('now', 'localtime'));
INSERT INTO LEAVE_REQUEST VALUES (4, 10, date('now', 'localtime', '+10 days'), date('now', 'localtime', '+16 days'), 'Going home for festival', 'Approved', date('now', 'localtime', '-8 days'));
INSERT INTO LEAVE_REQUEST VALUES (5, 7, date('now', 'localtime', '+1 days'), date('now', 'localtime', '+2 days'), 'Personal work', 'Rejected', date('now', 'localtime', '-3 days'));

INSERT INTO INVENTORY VALUES (1, 101, 'Bed', 3, 'Good', date('now', 'localtime', '-38 days'));
INSERT INTO INVENTORY VALUES (2, 101, 'Study Table', 3, 'Good', date('now', 'localtime', '-79 days'));
INSERT INTO INVENTORY VALUES (3, 101, 'Chair', 3, 'Good', date('now', 'localtime', '-11 days'));
INSERT INTO INVENTORY VALUES (4, 101, 'Ceiling Fan', 1, 'Good', date('now', 'localtime', '-17 days'));
INSERT INTO INVENTORY VALUES (5, 101, 'Wardrobe', 3, 'Good', date('now', 'localtime', '-67 days'));
INSERT INTO INVENTORY VALUES (6, 101, 'Tube Light', 2, 'Good', date('now', 'localtime', '-55 days'));
INSERT INTO INVENTORY VALUES (7, 102, 'Bed', 3, 'Good', date('now', 'localtime', '-23 days'));
INSERT INTO INVENTORY VALUES (8, 102, 'Study Table', 3, 'Good', date('now', 'localtime', '-45 days'));
INSERT INTO INVENTORY VALUES (9, 102, 'Chair', 3, 'Good', date('now', 'localtime', '-21 days'));
INSERT INTO INVENTORY VALUES (10, 102, 'Ceiling Fan', 1, 'Needs Repair', date('now', 'localtime', '-64 days'));
INSERT INTO INVENTORY VALUES (11, 102, 'Wardrobe', 3, 'Good', date('now', 'localtime', '-55 days'));
INSERT INTO INVENTORY VALUES (12, 102, 'Tube Light', 2, 'Good', date('now', 'localtime', '-7 days'));
INSERT INTO INVENTORY VALUES (13, 201, 'Bed', 2, 'Good', date('now', 'localtime', '-87 days'));
INSERT INTO INVENTORY VALUES (14, 201, 'Study Table', 2, 'Good', date('now', 'localtime', '-11 days'));
INSERT INTO INVENTORY VALUES (15, 201, 'Chair', 2, 'Good', date('now', 'localtime', '-73 days'));
INSERT INTO INVENTORY VALUES (16, 201, 'Ceiling Fan', 1, 'Good', date('now', 'localtime', '-75 days'));
INSERT INTO INVENTORY VALUES (17, 201, 'Wardrobe', 2, 'Good', date('now', 'localtime', '-42 days'));
INSERT INTO INVENTORY VALUES (18, 201, 'Tube Light', 2, 'Needs Repair', date('now', 'localtime', '-45 days'));
INSERT INTO INVENTORY VALUES (19, 202, 'Bed', 2, 'Good', date('now', 'localtime', '-90 days'));
INSERT INTO INVENTORY VALUES (20, 202, 'Study Table', 2, 'Good', date('now', 'localtime', '-46 days'));
INSERT INTO INVENTORY VALUES (21, 202, 'Chair', 2, 'Good', date('now', 'localtime', '-78 days'));
INSERT INTO INVENTORY VALUES (22, 202, 'Ceiling Fan', 1, 'Good', date('now', 'localtime', '-65 days'));
INSERT INTO INVENTORY VALUES (23, 202, 'Wardrobe', 2, 'Good', date('now', 'localtime', '-76 days'));
INSERT INTO INVENTORY VALUES (24, 202, 'Tube Light', 2, 'Good', date('now', 'localtime', '-60 days'));
INSERT INTO INVENTORY VALUES (25, 302, 'Bed', 4, 'Good', date('now', 'localtime', '-10 days'));
INSERT INTO INVENTORY VALUES (26, 302, 'Study Table', 4, 'Damaged', date('now', 'localtime', '-13 days'));
INSERT INTO INVENTORY VALUES (27, 302, 'Chair', 4, 'Good', date('now', 'localtime', '-36 days'));
INSERT INTO INVENTORY VALUES (28, 302, 'Ceiling Fan', 1, 'Good', date('now', 'localtime', '-62 days'));
INSERT INTO INVENTORY VALUES (29, 302, 'Wardrobe', 4, 'Good', date('now', 'localtime', '-87 days'));
INSERT INTO INVENTORY VALUES (30, 302, 'Tube Light', 2, 'Good', date('now', 'localtime', '-10 days'));
INSERT INTO INVENTORY VALUES (31, 301, 'Bed', 4, 'Good', date('now', 'localtime', '-9 days'));
INSERT INTO INVENTORY VALUES (32, 301, 'Study Table', 4, 'Good', date('now', 'localtime', '-41 days'));
INSERT INTO INVENTORY VALUES (33, 301, 'Chair', 4, 'Good', date('now', 'localtime', '-84 days'));
INSERT INTO INVENTORY VALUES (34, 301, 'Ceiling Fan', 1, 'Good', date('now', 'localtime', '-75 days'));
INSERT INTO INVENTORY VALUES (35, 301, 'Wardrobe', 4, 'Good', date('now', 'localtime', '-89 days'));
INSERT INTO INVENTORY VALUES (36, 301, 'Tube Light', 2, 'Good', date('now', 'localtime', '-59 days'));

INSERT INTO NOTICE VALUES (1, 'Water supply maintenance', 'Water supply will be off in B-Block on Saturday from 10 AM to 1 PM for tank cleaning. Please store water in advance.', 'Important', 'admin', datetime('now', 'localtime', '-2 days'));
INSERT INTO NOTICE VALUES (2, 'Hostel day celebrations', 'Hostel day will be celebrated next month. Students interested in volunteering can meet the warden.', 'Normal', 'admin', datetime('now', 'localtime', '-6 days'));
INSERT INTO NOTICE VALUES (3, 'Fee payment reminder', 'Students with pending room rent or mess fees are requested to clear dues at the hostel office at the earliest.', 'Urgent', 'admin', datetime('now', 'localtime', '-1 days'));
