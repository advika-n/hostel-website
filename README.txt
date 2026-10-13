HOSTEL DESK - hostel management website (Java + Oracle + plain HTML/CSS/JS)

You need: JDK 11 or newer, Oracle (XE or the college server), the ojdbc8.jar file.

1. Put this folder and ojdbc8.jar together (copy ojdbc8.jar into this folder).

2. Create the tables. In SQL*Plus, connect as your Oracle user and run:
       @hostel_schema.sql
   (For the XE laptop setup: user hostel / hostel123, service XEPDB1.)
   WARNING: it drops and recreates ROOM, STUDENT, WARDEN, FEE, COMPLAINT,
   VISITOR, LEAVE_REQUEST, INVENTORY, NOTICE, APP_USER and AUDIT_LOG.
   ROOM.OCCUPIED is now worked out from student allotments, not typed by hand.

3. Compile (once):
       javac HostelServer.java

4. Run (Windows, from this folder):
       java -cp ".;ojdbc8.jar" HostelServer --db localhost:1521/XEPDB1 --user hostel --pass hostel123
   Mac/Linux: use ":" instead of ";" in -cp.
   If you leave --db/--user/--pass out, it asks for them.
   College server example: --db win-2e2rkdsd915:1521/orcl --user <your id> --pass <your password>

5. Open http://localhost:8080
   First login: admin / admin123  (change it from the account menu).

Options: --port 9000   --public (let other computers on the network open it)

What is inside: dashboard with room map and charts, rooms, students (allot, move,
vacate), wardens, room inventory, fees (record payment, generate fees for all),
complaints, visitors (check out), leave requests (approve/reject), notice board,
9 reports, audit log, users with admin/viewer roles, global search (press /),
dark mode, CSV export, print.
