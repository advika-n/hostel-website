import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.*;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.*;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

/**
 * Hostel Management System - web server.
 * Plain Java: JDK HttpServer + JDBC (Oracle). No frameworks needed.
 *
 * Run:  java -cp ".;ojdbc8.jar" HostelServer
 *   optional: --db localhost:1521/XEPDB1 --user hostel --pass secret --port 8080 --public
 */
public class HostelServer {

    // ============================================================ config / state
    static String dbUrl, dbUser, dbPass;
    static int port = 8080;
    static boolean publicBind = false;
    static Path webDir = Paths.get("web");
    static Pool pool;
    static final SecureRandom RNG = new SecureRandom();
    static final Map<String, Session> sessions = new ConcurrentHashMap<>();
    static final Map<String, long[]> failures = new ConcurrentHashMap<>();   // user -> {count, firstTime}
    static final Map<String, TableDef> TABLES = new LinkedHashMap<>();
    static final long SESSION_IDLE_MS = 2L * 60 * 60 * 1000;

    static class Session { String user, role; long last = System.currentTimeMillis(); }

    static class ApiException extends RuntimeException {
        final int status;
        ApiException(int status, String msg) { super(msg); this.status = status; }
    }
    static ApiException bad(String m) { return new ApiException(400, m); }

    // ============================================================ main
    public static void main(String[] args) throws Exception {
        String db = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--db":     db = args[++i]; break;
                case "--user":   dbUser = args[++i]; break;
                case "--pass":   dbPass = args[++i]; break;
                case "--port":   port = Integer.parseInt(args[++i]); break;
                case "--web":    webDir = Paths.get(args[++i]); break;
                case "--public": publicBind = true; break;
                default: System.out.println("Unknown option " + args[i]);
            }
        }
        System.out.println("=== Hostel Management System ===");
        if (db == null)     db = prompt("Database (host:port/service) [localhost:1521/XEPDB1]: ", "localhost:1521/XEPDB1", false);
        if (dbUser == null) dbUser = prompt("Oracle username: ", null, false);
        if (dbPass == null) dbPass = prompt("Oracle password: ", null, true);
        if (db.startsWith("jdbc:")) dbUrl = db;
        else if (db.contains("/")) dbUrl = "jdbc:oracle:thin:@//" + db;
        else dbUrl = "jdbc:oracle:thin:@" + db;

        try { Class.forName("oracle.jdbc.OracleDriver"); } catch (Throwable ignore) { /* other drivers load themselves */ }
        try {
            pool = new Pool(dbUrl, dbUser, dbPass, 6);
        } catch (SQLException e) {
            System.out.println("\nCould not connect to the database: " + e.getMessage());
            System.out.println("URL used: " + dbUrl + "   user: " + dbUser);
            System.exit(1);
        }
        defineTables();
        ensureAdmin();

        InetAddress bind = publicBind ? null : InetAddress.getLoopbackAddress();
        HttpServer server;
        try {
            server = HttpServer.create(new InetSocketAddress(bind, port), 0);
        } catch (IOException e) {
            System.out.println("\nCould not start on port " + port + " (" + e.getMessage() + "). Try:  --port 8081");
            System.exit(1);
            return;
        }
        server.createContext("/api/", HostelServer::handleApi);
        server.createContext("/", HostelServer::handleStatic);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
        System.out.println("\nConnected to Oracle as " + dbUser);
        System.out.println("Website running at  http://localhost:" + port + (publicBind ? "   (open to the network)" : "   (this computer only)"));
        System.out.println("Press Ctrl+C to stop.\n");
    }

    static String prompt(String label, String def, boolean secret) {
        Console cons = System.console();
        String v;
        if (cons != null) {
            if (secret) { char[] p = cons.readPassword(label); v = p == null ? "" : new String(p); }
            else v = cons.readLine(label);
        } else {
            System.out.print(label);
            v = new Scanner(System.in).nextLine();
        }
        if (v == null || v.trim().isEmpty()) v = def;
        if (v == null) { System.out.println("A value is required."); System.exit(1); }
        return secret ? v : v.trim();
    }

    // ============================================================ connection pool
    static class Pool {
        final Semaphore slots;
        final ConcurrentLinkedQueue<Connection> idle = new ConcurrentLinkedQueue<>();
        final String url, user, pass;
        Pool(String url, String user, String pass, int n) throws SQLException {
            this.url = url; this.user = user; this.pass = pass;
            slots = new Semaphore(n);
            idle.add(open());               // fail fast if the login is wrong
        }
        Connection open() throws SQLException {
            Connection c = DriverManager.getConnection(url, user, pass);
            c.setAutoCommit(true);
            return c;
        }
        Connection take() throws Exception {
            if (!slots.tryAcquire(15, TimeUnit.SECONDS)) throw new ApiException(503, "Server is busy, try again.");
            try {
                Connection c = idle.poll();
                if (c != null) {
                    boolean ok;
                    try { ok = !c.isClosed() && c.isValid(2); } catch (SQLException e) { ok = false; }
                    if (!ok) { try { c.close(); } catch (Exception ignore) { } c = null; }
                }
                return c != null ? c : open();
            } catch (Exception e) { slots.release(); throw e; }
        }
        void give(Connection c) {
            try {
                if (!c.getAutoCommit()) { c.rollback(); c.setAutoCommit(true); }
                idle.add(c);
            } catch (SQLException e) { try { c.close(); } catch (Exception ignore) { } }
            slots.release();
        }
    }

    interface Work<T> { T run(Connection c) throws Exception; }

    static <T> T db(Work<T> w) throws Exception {
        Connection c = pool.take();
        try { return w.run(c); } finally { pool.give(c); }
    }

    /** runs the work as one transaction (commit on success, rollback on any error) */
    static <T> T tx(Work<T> w) throws Exception {
        return db(c -> {
            c.setAutoCommit(false);
            try {
                T r = w.run(c);
                c.commit();
                return r;
            } catch (Exception e) {
                try { c.rollback(); } catch (Exception ignore) { }
                throw e;
            } finally {
                c.setAutoCommit(true);
            }
        });
    }

    // ============================================================ JDBC helpers
    static void bind(PreparedStatement ps, Object... p) throws SQLException {
        for (int i = 0; i < p.length; i++) {
            if (p[i] == null) ps.setNull(i + 1, Types.VARCHAR);
            else ps.setObject(i + 1, p[i]);
        }
    }

    static Object norm(Object v) {
        if (v instanceof BigDecimal) {
            BigDecimal b = ((BigDecimal) v).stripTrailingZeros();
            return b.scale() <= 0 ? (Object) b.longValue() : (Object) b.doubleValue();
        }
        if (v instanceof Timestamp || v instanceof java.sql.Date) return v.toString();
        return v;
    }

    static List<Map<String, Object>> rows(Connection c, String sql, Object... p) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, p);
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                int n = md.getColumnCount();
                List<Map<String, Object>> out = new ArrayList<>();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= n; i++) {
                        String k = md.getColumnLabel(i).toLowerCase();
                        if (k.equals("rn__")) continue;
                        row.put(k, norm(rs.getObject(i)));
                    }
                    out.add(row);
                }
                return out;
            }
        }
    }

    /** rows as plain arrays (used by reports, column labels do not matter) */
    static List<List<Object>> grid(Connection c, String sql, Object... p) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, p);
            try (ResultSet rs = ps.executeQuery()) {
                int n = rs.getMetaData().getColumnCount();
                List<List<Object>> out = new ArrayList<>();
                while (rs.next()) {
                    List<Object> row = new ArrayList<>();
                    for (int i = 1; i <= n; i++) row.add(norm(rs.getObject(i)));
                    out.add(row);
                }
                return out;
            }
        }
    }

    static Map<String, Object> one(Connection c, String sql, Object... p) throws SQLException {
        List<Map<String, Object>> r = rows(c, sql, p);
        return r.isEmpty() ? null : r.get(0);
    }

    static long num(Connection c, String sql, Object... p) throws SQLException {
        List<List<Object>> g = grid(c, sql, p);
        if (g.isEmpty() || g.get(0).get(0) == null) return 0;
        return ((Number) g.get(0).get(0)).longValue();
    }

    static int exec(Connection c, String sql, Object... p) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, p);
            return ps.executeUpdate();
        }
    }

    static long nextVal(Connection c, String seq) throws SQLException {
        return num(c, "SELECT " + seq + ".NEXTVAL FROM DUAL");
    }

    static void audit(Connection c, String user, String action, String table, String detail) throws SQLException {
        if (detail != null && detail.length() > 290) detail = detail.substring(0, 290);
        exec(c, "INSERT INTO AUDIT_LOG (LOG_ID, USERNAME, ACTION, TABLE_NAME, DETAIL, LOG_TIME) VALUES (SEQ_AUDIT.NEXTVAL, ?, ?, ?, ?, SYSDATE)",
             user, action, table, detail);
    }

    static String friendly(SQLException e) {
        int code = e.getErrorCode();
        String st = e.getSQLState() == null ? "" : e.getSQLState();
        String m = String.valueOf(e.getMessage());
        String mu = m.toUpperCase();
        if (code == 1 || st.equals("23505")) return "A record with the same unique value already exists.";
        if (code == 2290 || st.equals("23513")) {
            if (mu.contains("CHK_OCC")) return "Occupied beds cannot be more than the room capacity.";
            if (mu.contains("CHK_LEAVE")) return "Leave end date cannot be before the start date.";
            return "A value is outside the allowed range.";
        }
        if (code == 2291) return "The selected related record does not exist.";
        if (code == 2292) return "This record is still used by other records, so it cannot be deleted.";
        if (st.equals("23503")) return "This record is linked to other records.";
        if (code == 1400 || code == 1407 || st.equals("23502")) return "A required value is missing.";
        if (code == 12899 || st.equals("22001")) return "A value is too long for its field.";
        if (code == 942) return "Table not found. Did you run hostel_schema.sql with this user?";
        String first = m.split("\n")[0];
        return first.length() > 200 ? first.substring(0, 200) : first;
    }

    // ============================================================ JSON
    static class Json {
        static Object parse(String s) {
            P p = new P(s);
            try {
                p.ws();
                Object v = p.val();
                p.ws();
                if (p.i != s.length()) throw bad("Invalid JSON.");
                return v;
            } catch (IndexOutOfBoundsException e) { throw bad("Invalid JSON."); }
        }
        static class P {
            final String s; int i = 0;
            P(String s) { this.s = s; }
            void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
            Object val() {
                char c = s.charAt(i);
                if (c == '{') return obj();
                if (c == '[') return arr();
                if (c == '"') return str();
                if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
                if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
                if (s.startsWith("null", i)) { i += 4; return null; }
                int st = i;
                while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
                if (st == i) throw bad("Invalid JSON.");
                try { return new BigDecimal(s.substring(st, i)); } catch (NumberFormatException e) { throw bad("Invalid JSON."); }
            }
            Map<String, Object> obj() {
                Map<String, Object> m = new LinkedHashMap<>();
                i++; ws();
                if (s.charAt(i) == '}') { i++; return m; }
                while (true) {
                    ws();
                    String k = str();
                    ws();
                    if (s.charAt(i++) != ':') throw bad("Invalid JSON.");
                    ws();
                    m.put(k, val());
                    ws();
                    char c = s.charAt(i++);
                    if (c == '}') return m;
                    if (c != ',') throw bad("Invalid JSON.");
                }
            }
            List<Object> arr() {
                List<Object> l = new ArrayList<>();
                i++; ws();
                if (s.charAt(i) == ']') { i++; return l; }
                while (true) {
                    ws();
                    l.add(val());
                    ws();
                    char c = s.charAt(i++);
                    if (c == ']') return l;
                    if (c != ',') throw bad("Invalid JSON.");
                }
            }
            String str() {
                if (s.charAt(i) != '"') throw bad("Invalid JSON.");
                i++;
                StringBuilder b = new StringBuilder();
                while (true) {
                    char c = s.charAt(i++);
                    if (c == '"') return b.toString();
                    if (c == '\\') {
                        char e = s.charAt(i++);
                        switch (e) {
                            case 'n': b.append('\n'); break;
                            case 't': b.append('\t'); break;
                            case 'r': b.append('\r'); break;
                            case 'b': b.append('\b'); break;
                            case 'f': b.append('\f'); break;
                            case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                            default: b.append(e);
                        }
                    } else b.append(c);
                }
            }
        }

        static String write(Object o) { StringBuilder b = new StringBuilder(); w(b, o); return b.toString(); }

        @SuppressWarnings("unchecked")
        static void w(StringBuilder b, Object o) {
            if (o == null) b.append("null");
            else if (o instanceof String) q(b, (String) o);
            else if (o instanceof Boolean) b.append(o);
            else if (o instanceof BigDecimal) b.append(((BigDecimal) o).toPlainString());
            else if (o instanceof Number) b.append(o);
            else if (o instanceof Map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    q(b, e.getKey()); b.append(':'); w(b, e.getValue());
                }
                b.append('}');
            } else if (o instanceof Iterable) {
                b.append('[');
                boolean first = true;
                for (Object x : (Iterable<Object>) o) { if (!first) b.append(','); first = false; w(b, x); }
                b.append(']');
            } else if (o instanceof Object[]) {
                w(b, Arrays.asList((Object[]) o));
            } else q(b, o.toString());
        }

        static void q(StringBuilder b, String s) {
            b.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 32 || c > 126) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
        }
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ============================================================ request wrapper
    static class Req {
        final HttpExchange ex;
        final String method;
        final List<String> seg = new ArrayList<>();
        final Map<String, String> q = new LinkedHashMap<>();
        Session s;
        Map<String, Object> body;

        Req(HttpExchange ex) throws IOException {
            this.ex = ex;
            this.method = ex.getRequestMethod();
            for (String p : ex.getRequestURI().getRawPath().split("/"))
                if (!p.isEmpty()) seg.add(URLDecoder.decode(p, "UTF-8"));
            String rq = ex.getRequestURI().getRawQuery();
            if (rq != null) for (String kv : rq.split("&")) {
                if (kv.isEmpty()) continue;
                int eq = kv.indexOf('=');
                String k = URLDecoder.decode(eq < 0 ? kv : kv.substring(0, eq), "UTF-8");
                String v = eq < 0 ? "" : URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                q.put(k, v);
            }
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> body() throws IOException {
            if (body != null) return body;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            InputStream in = ex.getRequestBody();
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (bo.size() > 1_000_000) throw bad("Request too large.");
            }
            String txt = new String(bo.toByteArray(), StandardCharsets.UTF_8).trim();
            if (txt.isEmpty()) body = new LinkedHashMap<>();
            else {
                Object o = Json.parse(txt);
                if (!(o instanceof Map)) throw bad("Expected a JSON object.");
                body = (Map<String, Object>) o;
            }
            return body;
        }

        String cookie(String name) {
            String h = ex.getRequestHeaders().getFirst("Cookie");
            if (h == null) return null;
            for (String part : h.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals(name)) return kv[1];
            }
            return null;
        }
    }

    static String text(Map<String, Object> b, String k) {
        Object v = b.get(k);
        return v == null ? "" : (v instanceof BigDecimal ? ((BigDecimal) v).toPlainString() : v.toString().trim());
    }

    static long idOf(String s) {
        try { return Long.parseLong(s); } catch (NumberFormatException e) { throw bad("Invalid id."); }
    }

    // ============================================================ responses
    static void send(HttpExchange ex, int status, String type, byte[] data, String... extra) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set("Referrer-Policy", "same-origin");
        ex.getResponseHeaders().set("Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'");
        for (int i = 0; i + 1 < extra.length; i += 2) ex.getResponseHeaders().add(extra[i], extra[i + 1]);
        if (ex.getRequestMethod().equals("HEAD")) { ex.sendResponseHeaders(status, -1); ex.close(); return; }
        ex.sendResponseHeaders(status, data.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(data); }
    }

    static void sendJson(HttpExchange ex, int status, Object o, String... extra) throws IOException {
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        send(ex, status, "application/json; charset=utf-8", Json.write(o).getBytes(StandardCharsets.UTF_8), extra);
    }

    static void handleStatic(HttpExchange ex) throws IOException {
        try {
            String m = ex.getRequestMethod();
            if (!m.equals("GET") && !m.equals("HEAD")) { send(ex, 405, "text/plain", "Method not allowed".getBytes()); return; }
            String p = ex.getRequestURI().getPath();
            if (p.equals("/") || p.isEmpty()) p = "/index.html";
            Path root = webDir.toAbsolutePath().normalize();
            Path f = root.resolve(p.substring(1)).normalize();
            if (!f.startsWith(root) || !Files.isRegularFile(f)) {
                send(ex, 404, "text/plain; charset=utf-8", "Not found".getBytes());
                return;
            }
            String n = f.getFileName().toString().toLowerCase();
            String type = n.endsWith(".html") ? "text/html; charset=utf-8"
                : n.endsWith(".css") ? "text/css; charset=utf-8"
                : n.endsWith(".js") ? "application/javascript; charset=utf-8"
                : n.endsWith(".svg") ? "image/svg+xml"
                : n.endsWith(".png") ? "image/png"
                : n.endsWith(".ico") ? "image/x-icon"
                : n.endsWith(".json") ? "application/json" : "application/octet-stream";
            ex.getResponseHeaders().set("Cache-Control", "no-cache");
            send(ex, 200, type, Files.readAllBytes(f));
        } catch (Exception e) {
            send(ex, 500, "text/plain", "Error".getBytes());
        } finally {
            ex.close();
        }
    }

    // ============================================================ API entry
    static void handleApi(HttpExchange ex) throws IOException {
        long t0 = System.currentTimeMillis();
        int status = 200;
        String pathForLog = ex.getRequestURI().getPath();
        try {
            Req r = new Req(ex);
            Object out = route(r);
            if (out instanceof Object[] && ((Object[]) out).length == 2 && ((Object[]) out)[0] instanceof String[]) {
                // login: {cookieHeaders, body}
                Object[] pair = (Object[]) out;
                sendJson(ex, 200, pair[1], (String[]) pair[0]);
            } else sendJson(ex, 200, out);
        } catch (ApiException e) {
            status = e.status;
            sendJson(ex, e.status, map("error", e.getMessage()));
        } catch (SQLException e) {
            status = 400;
            System.out.println("  SQL error: " + e.getMessage());
            sendJson(ex, 400, map("error", friendly(e)));
        } catch (Throwable e) {
            status = 500;
            e.printStackTrace();
            sendJson(ex, 500, map("error", "Something went wrong on the server."));
        } finally {
            ex.close();
            System.out.println(ex.getRequestMethod() + " " + pathForLog + " -> " + status + " (" + (System.currentTimeMillis() - t0) + " ms)");
        }
    }

    static Session sessionOf(Req r) {
        String tok = r.cookie("HSID");
        if (tok == null) return null;
        Session s = sessions.get(tok);
        if (s == null) return null;
        long now = System.currentTimeMillis();
        if (now - s.last > SESSION_IDLE_MS) { sessions.remove(tok); return null; }
        s.last = now;
        return s;
    }

    static Object route(Req r) throws Exception {
        List<String> sg = r.seg;               // sg.get(0) == "api"
        String a = sg.size() > 1 ? sg.get(1) : "";
        String m = r.method;

        if (a.equals("login") && m.equals("POST")) return login(r);

        r.s = sessionOf(r);
        if (r.s == null) throw new ApiException(401, "Please sign in.");
        boolean admin = r.s.role.equals("ADMIN");

        if (a.equals("me")) return map("username", r.s.user, "role", r.s.role);
        if (a.equals("logout") && m.equals("POST")) {
            String tok = r.cookie("HSID");
            if (tok != null) sessions.remove(tok);
            return map("ok", true);
        }
        if (a.equals("password") && m.equals("POST")) return changePassword(r);

        if (!m.equals("GET") && !admin) throw new ApiException(403, "Your account is read-only.");

        switch (a) {
            case "meta":      return meta(r);
            case "dashboard": return db(c -> dashboard(c, admin));
            case "search":    return db(c -> search(c, r.q.getOrDefault("q", "").trim()));
            case "lookup":    return db(c -> lookup(c, sg.size() > 2 ? sg.get(2) : ""));
            case "reports":   return db(c -> report(c, sg.size() > 2 ? sg.get(2) : ""));
            case "users":
                if (!admin) throw new ApiException(403, "Admins only.");
                return users(r);
            default:
                break;
        }

        TableDef t = TABLES.get(a);
        if (t == null) throw new ApiException(404, "Unknown resource.");
        if (t.adminOnly && !admin) throw new ApiException(403, "Admins only.");
        return tableRoute(r, t);
    }

    // ============================================================ auth
    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
    static byte[] unhex(String h) {
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
    static String newSalt() { byte[] b = new byte[16]; RNG.nextBytes(b); return hex(b); }
    static String hashPw(String pw, String salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pw.toCharArray(), unhex(salt), 65536, 256);
        return hex(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded());
    }

    static void ensureAdmin() throws Exception {
        try {
            db(c -> {
                if (num(c, "SELECT COUNT(*) FROM APP_USER") == 0) {
                    String salt = newSalt();
                    exec(c, "INSERT INTO APP_USER (USERNAME, PASSWORD_HASH, SALT, ROLE, CREATED_ON) VALUES (?, ?, ?, 'ADMIN', SYSDATE)",
                         "admin", hashPw("admin123", salt), salt);
                    System.out.println("Created the first login:  admin / admin123   (change it on the Users page)");
                }
                return null;
            });
        } catch (SQLException e) {
            System.out.println("\nThe hostel tables were not found for user " + dbUser + ".");
            System.out.println("Run hostel_schema.sql in SQL*Plus with this same user, then start the server again.");
            System.out.println("(" + e.getMessage().split("\n")[0] + ")");
            System.exit(1);
        }
    }

    static Object login(Req r) throws Exception {
        Map<String, Object> b = r.body();
        String user = text(b, "username"), pw = b.get("password") == null ? "" : b.get("password").toString();
        if (user.isEmpty() || pw.isEmpty()) throw bad("Enter your username and password.");
        String key = user.toLowerCase();
        long[] f = failures.get(key);
        long now = System.currentTimeMillis();
        if (f != null && now - f[1] > 5 * 60 * 1000) { failures.remove(key); f = null; }
        if (f != null && f[0] >= 5) throw new ApiException(429, "Too many failed attempts. Try again in a few minutes.");

        Map<String, Object> u = db(c -> one(c, "SELECT USERNAME, PASSWORD_HASH, SALT, ROLE FROM APP_USER WHERE UPPER(USERNAME) = UPPER(?)", user));
        boolean ok = false;
        if (u != null) {
            String h = hashPw(pw, (String) u.get("salt"));
            ok = MessageDigest.isEqual(h.getBytes(StandardCharsets.UTF_8), ((String) u.get("password_hash")).getBytes(StandardCharsets.UTF_8));
        } else hashPw(pw, newSalt());                      // keep timing similar
        if (!ok) {
            long[] ff = failures.computeIfAbsent(key, k -> new long[]{0, now});
            ff[0]++;
            throw new ApiException(401, "Wrong username or password.");
        }
        failures.remove(key);
        Session s = new Session();
        s.user = (String) u.get("username");
        s.role = (String) u.get("role");
        byte[] tb = new byte[32];
        RNG.nextBytes(tb);
        String token = hex(tb);
        sessions.put(token, s);
        final String uname = s.user;
        db(c -> { exec(c, "UPDATE APP_USER SET LAST_LOGIN = SYSDATE WHERE USERNAME = ?", uname); return null; });
        return new Object[]{
            new String[]{"Set-Cookie", "HSID=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200"},
            map("username", s.user, "role", s.role)};
    }

    static Object changePassword(Req r) throws Exception {
        Map<String, Object> b = r.body();
        String oldPw = b.get("old_password") == null ? "" : b.get("old_password").toString();
        String newPw = b.get("new_password") == null ? "" : b.get("new_password").toString();
        if (newPw.length() < 6) throw bad("New password must be at least 6 characters.");
        String user = r.s.user;
        return tx(c -> {
            Map<String, Object> u = one(c, "SELECT PASSWORD_HASH, SALT FROM APP_USER WHERE USERNAME = ?", user);
            if (u == null) throw new ApiException(404, "User not found.");
            String h = hashPw(oldPw, (String) u.get("salt"));
            if (!MessageDigest.isEqual(h.getBytes(StandardCharsets.UTF_8), ((String) u.get("password_hash")).getBytes(StandardCharsets.UTF_8)))
                throw bad("Current password is wrong.");
            String salt = newSalt();
            exec(c, "UPDATE APP_USER SET PASSWORD_HASH = ?, SALT = ? WHERE USERNAME = ?", hashPw(newPw, salt), salt, user);
            audit(c, user, "PASSWORD", "APP_USER", "changed own password");
            return map("ok", true);
        });
    }

    static Object users(Req r) throws Exception {
        String m = r.method;
        String target = r.seg.size() > 2 ? r.seg.get(2) : null;
        String me = r.s.user;
        if (m.equals("GET")) {
            return db(c -> map("rows", rows(c,
                "SELECT USERNAME, ROLE, TO_CHAR(CREATED_ON, 'YYYY-MM-DD') CREATED_ON, TO_CHAR(LAST_LOGIN, 'YYYY-MM-DD HH24:MI') LAST_LOGIN FROM APP_USER ORDER BY USERNAME")));
        }
        Map<String, Object> b = r.body();
        if (m.equals("POST")) {
            String u = text(b, "username"), role = text(b, "role").toUpperCase();
            String pw = b.get("password") == null ? "" : b.get("password").toString();
            if (!u.matches("[A-Za-z0-9_.-]{3,30}")) throw bad("Username must be 3-30 letters, digits, dot, dash or underscore.");
            if (pw.length() < 6) throw bad("Password must be at least 6 characters.");
            if (!role.equals("ADMIN") && !role.equals("VIEWER")) throw bad("Role must be ADMIN or VIEWER.");
            return tx(c -> {
                if (num(c, "SELECT COUNT(*) FROM APP_USER WHERE UPPER(USERNAME) = UPPER(?)", u) > 0) throw bad("That username is taken.");
                String salt = newSalt();
                exec(c, "INSERT INTO APP_USER (USERNAME, PASSWORD_HASH, SALT, ROLE, CREATED_ON) VALUES (?, ?, ?, ?, SYSDATE)", u, hashPw(pw, salt), salt, role);
                audit(c, me, "CREATE", "APP_USER", u + " (" + role + ")");
                return map("ok", true);
            });
        }
        if (target == null) throw bad("Missing username.");
        if (m.equals("PUT")) {
            String role = text(b, "role").toUpperCase();
            String pw = b.get("password") == null ? "" : b.get("password").toString();
            return tx(c -> {
                if (num(c, "SELECT COUNT(*) FROM APP_USER WHERE USERNAME = ?", target) == 0) throw new ApiException(404, "User not found.");
                if (!role.isEmpty()) {
                    if (!role.equals("ADMIN") && !role.equals("VIEWER")) throw bad("Role must be ADMIN or VIEWER.");
                    if (role.equals("VIEWER") && num(c, "SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME <> ?", target) == 0)
                        throw bad("There must be at least one admin.");
                    exec(c, "UPDATE APP_USER SET ROLE = ? WHERE USERNAME = ?", role, target);
                    for (Session s : sessions.values()) if (s.user.equals(target)) s.role = role;
                }
                if (!pw.isEmpty()) {
                    if (pw.length() < 6) throw bad("Password must be at least 6 characters.");
                    String salt = newSalt();
                    exec(c, "UPDATE APP_USER SET PASSWORD_HASH = ?, SALT = ? WHERE USERNAME = ?", hashPw(pw, salt), salt, target);
                }
                audit(c, me, "UPDATE", "APP_USER", target + (role.isEmpty() ? "" : " role=" + role) + (pw.isEmpty() ? "" : " password reset"));
                return map("ok", true);
            });
        }
        if (m.equals("DELETE")) {
            if (target.equalsIgnoreCase(me)) throw bad("You cannot delete your own account.");
            return tx(c -> {
                if (num(c, "SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME <> ?", target) == 0
                    && num(c, "SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME = ?", target) > 0)
                    throw bad("There must be at least one admin.");
                int n = exec(c, "DELETE FROM APP_USER WHERE USERNAME = ?", target);
                if (n == 0) throw new ApiException(404, "User not found.");
                sessions.values().removeIf(s -> s.user.equals(target));
                audit(c, me, "DELETE", "APP_USER", target);
                return map("ok", true);
            });
        }
        throw new ApiException(405, "Method not allowed.");
    }

    // ============================================================ table definitions
    static class Field {
        String key, label, type, sql, col;
        boolean required, list = true, form = true, createOnly, filter, range, autoUser, sortable = true;
        Double min, max;
        Integer maxLen;
        String pattern, patternHint, defaultSql, ref, help;
        String[] options;

        Field(String key, String label, String type, String sql) { this.key = key; this.label = label; this.type = type; this.sql = sql; }
        Field col(String c) { this.col = c; return this; }
        Field req() { required = true; return this; }
        Field opts(String... o) { options = o; return this; }
        Field ref(String r) { ref = r; return this; }
        Field min(double v) { min = v; return this; }
        Field max(double v) { max = v; return this; }
        Field len(int n) { maxLen = n; return this; }
        Field pat(String p, String hint) { pattern = p; patternHint = hint; return this; }
        Field noList() { list = false; return this; }
        Field noForm() { form = false; return this; }
        Field def(String s) { defaultSql = s; return this; }
        Field auto() { autoUser = true; form = false; return this; }
        Field filter() { filter = true; return this; }
        Field range() { range = true; return this; }
        Field createOnly() { createOnly = true; return this; }
        Field help(String h) { help = h; return this; }

        String selectExpr() {
            if (type.equals("date")) return "TO_CHAR(" + sql + ", 'YYYY-MM-DD')";
            if (type.equals("datetime")) return "TO_CHAR(" + sql + ", 'YYYY-MM-DD HH24:MI')";
            return sql;
        }
    }

    interface Check { void run(Connection c, Map<String, Object> vals, Object id) throws Exception; }
    interface Hook { void run(Connection c, long id) throws Exception; }

    static class TableDef {
        String key, title, dbName, from, pk, pkSql, seq, defaultSort, defaultDir = "asc";
        boolean readOnly, adminOnly;
        List<Field> fields = new ArrayList<>();
        List<String> search = new ArrayList<>();
        Map<String, String[]> flags = new LinkedHashMap<>();       // key -> {label, sql condition}
        Check check;
        Hook beforeDelete;

        TableDef(String key, String title, String dbName, String from, String pk, String pkSql, String seq) {
            this.key = key; this.title = title; this.dbName = dbName; this.from = from; this.pk = pk; this.pkSql = pkSql; this.seq = seq;
            this.defaultSort = pk;
        }
        String pkCol() { return pk.toUpperCase(); }
        Field add(Field f) { fields.add(f); return f; }
        Field field(String k) { for (Field f : fields) if (f.key.equals(k)) return f; return null; }
        TableDef flag(String k, String label, String cond) { flags.put(k, new String[]{label, cond}); return this; }
        TableDef search(String... keys) { search.addAll(Arrays.asList(keys)); return this; }
        TableDef sort(String k, String dir) { defaultSort = k; defaultDir = dir; return this; }
        String selectList() {
            StringBuilder b = new StringBuilder();
            for (Field f : fields) {
                if (b.length() > 0) b.append(", ");
                b.append(f.selectExpr()).append(" AS ").append(f.key);
            }
            return b.toString();
        }
    }

    static Field F(String key, String label, String type, String sql) { return new Field(key, label, type, sql); }

    static final String[] DEPTS = {"CSE", "IT", "ECE", "EEE", "Mechanical", "Civil", "Other"};

    static void defineTables() {
        // ---- rooms
        TableDef rooms = new TableDef("rooms", "Rooms", "ROOM", "ROOM R", "room_no", "R.ROOM_NO", null);
        rooms.add(F("room_no", "Room No", "int", "R.ROOM_NO").col("ROOM_NO").req().min(1).max(9999).createOnly());
        rooms.add(F("block", "Block", "str", "R.BLOCK").col("BLOCK").req().len(10).filter().ref("blocks"));
        rooms.add(F("capacity", "Capacity", "int", "R.CAPACITY").col("CAPACITY").req().min(1).max(99));
        rooms.add(F("occupied", "Occupied", "int", "R.OCCUPIED").col("OCCUPIED").noForm().def("0"));
        rooms.add(F("vacant", "Vacant", "int", "(R.CAPACITY - R.OCCUPIED)").noForm());
        rooms.add(F("occupancy", "Occupancy %", "int", "ROUND(R.OCCUPIED * 100 / NULLIF(R.CAPACITY, 0), 0)").noForm());
        rooms.add(F("rent", "Rent", "num", "R.RENT").col("RENT").req().min(1).max(999999.99).range());
        rooms.search("room_no", "block");
        rooms.flag("vacant", "Has vacancy", "R.OCCUPIED < R.CAPACITY").flag("full", "Full", "R.OCCUPIED >= R.CAPACITY").flag("empty", "Empty", "R.OCCUPIED = 0");
        rooms.check = (c, v, id) -> {
            if (id != null && v.get("capacity") != null) {
                long occ = num(c, "SELECT OCCUPIED FROM ROOM WHERE ROOM_NO = ?", id);
                if (((Number) v.get("capacity")).longValue() < occ)
                    throw bad("Capacity cannot be less than the " + occ + " students already in this room.");
            }
        };
        TABLES.put(rooms.key, rooms);

        // ---- students
        TableDef st = new TableDef("students", "Students", "STUDENT", "STUDENT S LEFT JOIN ROOM R ON R.ROOM_NO = S.ROOM_NO", "student_id", "S.STUDENT_ID", "SEQ_STUDENT");
        st.add(F("student_id", "ID", "int", "S.STUDENT_ID").noForm());
        st.add(F("reg_no", "Reg No", "str", "S.REG_NO").col("REG_NO").req().len(15).pat("[A-Za-z0-9]+", "Reg No can have only letters and digits."));
        st.add(F("name", "Name", "str", "S.NAME").col("NAME").req().len(50));
        st.add(F("department", "Department", "str", "S.DEPARTMENT").col("DEPARTMENT").req().opts(DEPTS).filter());
        st.add(F("year_of_study", "Year", "int", "S.YEAR_OF_STUDY").col("YEAR_OF_STUDY").req().min(1).max(5).filter());
        st.add(F("phone", "Phone", "str", "S.PHONE").col("PHONE").len(15).pat("[0-9+ -]{7,15}", "Enter a valid phone number."));
        st.add(F("email", "Email", "str", "S.EMAIL").col("EMAIL").len(60).pat("[^@\\s]+@[^@\\s]+\\.[^@\\s]+", "Enter a valid email address."));
        st.add(F("guardian_phone", "Guardian Phone", "str", "S.GUARDIAN_PHONE").col("GUARDIAN_PHONE").len(15).pat("[0-9+ -]{7,15}", "Enter a valid phone number.").noList());
        st.add(F("room_no", "Room", "int", "S.ROOM_NO").noForm().filter().ref("rooms"));
        st.add(F("block", "Block", "str", "R.BLOCK").noForm().filter().ref("blocks"));
        st.add(F("join_date", "Joined", "date", "S.JOIN_DATE").col("JOIN_DATE").def("TRUNC(SYSDATE)").range());
        st.search("name", "reg_no", "department", "phone", "email", "room_no");
        st.flag("unallotted", "No room yet", "S.ROOM_NO IS NULL").flag("allotted", "Has a room", "S.ROOM_NO IS NOT NULL");
        st.beforeDelete = (c, id) -> {
            Map<String, Object> s = one(c, "SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ? FOR UPDATE", id);
            if (s != null && s.get("room_no") != null)
                exec(c, "UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?", s.get("room_no"));
        };
        TABLES.put(st.key, st);

        // ---- wardens
        TableDef wd = new TableDef("wardens", "Wardens", "WARDEN", "WARDEN W", "warden_id", "W.WARDEN_ID", "SEQ_WARDEN");
        wd.add(F("warden_id", "ID", "int", "W.WARDEN_ID").noForm());
        wd.add(F("name", "Name", "str", "W.NAME").col("NAME").req().len(50));
        wd.add(F("phone", "Phone", "str", "W.PHONE").col("PHONE").len(15).pat("[0-9+ -]{7,15}", "Enter a valid phone number."));
        wd.add(F("email", "Email", "str", "W.EMAIL").col("EMAIL").len(60).pat("[^@\\s]+@[^@\\s]+\\.[^@\\s]+", "Enter a valid email address."));
        wd.add(F("block", "Block", "str", "W.BLOCK").col("BLOCK").req().len(10).filter().ref("blocks"));
        wd.add(F("shift_time", "Shift", "str", "W.SHIFT_TIME").col("SHIFT_TIME").opts("Morning", "Evening", "Night").filter());
        wd.search("name", "phone", "email", "block");
        TABLES.put(wd.key, wd);

        // ---- fees
        TableDef fee = new TableDef("fees", "Fees", "FEE", "FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID", "fee_id", "F.FEE_ID", "SEQ_FEE");
        fee.add(F("fee_id", "ID", "int", "F.FEE_ID").noForm());
        fee.add(F("student_id", "Student", "int", "F.STUDENT_ID").col("STUDENT_ID").req().ref("students").filter().noList());
        fee.add(F("student_name", "Student", "str", "S.NAME").noForm());
        fee.add(F("reg_no", "Reg No", "str", "S.REG_NO").noForm());
        fee.add(F("fee_type", "Type", "str", "F.FEE_TYPE").col("FEE_TYPE").req().opts("Room Rent", "Mess", "Maintenance", "Fine", "Other").filter());
        fee.add(F("amount", "Amount", "num", "F.AMOUNT").col("AMOUNT").req().min(1).max(999999.99).range());
        fee.add(F("due_date", "Due Date", "date", "F.DUE_DATE").col("DUE_DATE").req().range());
        fee.add(F("paid_date", "Paid On", "date", "F.PAID_DATE").col("PAID_DATE").help("Leave empty if not paid yet"));
        fee.add(F("pay_mode", "Pay Mode", "str", "F.PAY_MODE").col("PAY_MODE").opts("Cash", "UPI", "Card", "Net Banking").filter());
        fee.add(F("status", "Status", "str", "(CASE WHEN F.PAID_DATE IS NOT NULL THEN 'Paid' WHEN F.DUE_DATE < TRUNC(SYSDATE) THEN 'Overdue' ELSE 'Pending' END)")
                .noForm().opts("Paid", "Pending", "Overdue").filter());
        fee.search("student_name", "reg_no", "fee_type");
        fee.sort("due_date", "desc");
        fee.check = (c, v, id) -> {
            if (v.get("paid_date") != null && v.get("pay_mode") == null) throw bad("Choose the payment mode for a paid fee.");
            if (v.get("paid_date") == null && v.get("pay_mode") != null) throw bad("Add the paid date, or clear the payment mode.");
        };
        TABLES.put(fee.key, fee);

        // ---- complaints
        TableDef cp = new TableDef("complaints", "Complaints", "COMPLAINT", "COMPLAINT C JOIN STUDENT S ON S.STUDENT_ID = C.STUDENT_ID", "complaint_id", "C.COMPLAINT_ID", "SEQ_COMPLAINT");
        cp.add(F("complaint_id", "ID", "int", "C.COMPLAINT_ID").noForm());
        cp.add(F("student_id", "Student", "int", "C.STUDENT_ID").col("STUDENT_ID").req().ref("students").filter().noList());
        cp.add(F("student_name", "Student", "str", "S.NAME").noForm());
        cp.add(F("room_no", "Room", "int", "S.ROOM_NO").noForm());
        cp.add(F("category", "Category", "str", "C.CATEGORY").col("CATEGORY").req().opts("Electrical", "Plumbing", "Furniture", "Cleaning", "Internet", "Other").filter());
        cp.add(F("description", "Description", "text", "C.DESCRIPTION").col("DESCRIPTION").req().len(300));
        cp.add(F("priority", "Priority", "str", "C.PRIORITY").col("PRIORITY").opts("Low", "Medium", "High").def("'Medium'").filter());
        cp.add(F("status", "Status", "str", "C.STATUS").col("STATUS").noForm().def("'Open'").opts("Open", "In Progress", "Resolved").filter());
        cp.add(F("created_on", "Raised On", "date", "C.CREATED_ON").col("CREATED_ON").noForm().def("SYSDATE").range());
        cp.add(F("resolved_on", "Resolved On", "date", "C.RESOLVED_ON").noForm());
        cp.search("student_name", "category", "description");
        cp.sort("complaint_id", "desc");
        TABLES.put(cp.key, cp);

        // ---- visitors
        TableDef vs = new TableDef("visitors", "Visitors", "VISITOR", "VISITOR V JOIN STUDENT S ON S.STUDENT_ID = V.STUDENT_ID", "visitor_id", "V.VISITOR_ID", "SEQ_VISITOR");
        vs.add(F("visitor_id", "ID", "int", "V.VISITOR_ID").noForm());
        vs.add(F("student_id", "Student", "int", "V.STUDENT_ID").col("STUDENT_ID").req().ref("students").filter().noList());
        vs.add(F("student_name", "Visiting", "str", "S.NAME").noForm());
        vs.add(F("visitor_name", "Visitor", "str", "V.VISITOR_NAME").col("VISITOR_NAME").req().len(50));
        vs.add(F("relation", "Relation", "str", "V.RELATION").col("RELATION").opts("Parent", "Sibling", "Relative", "Friend", "Other").filter());
        vs.add(F("phone", "Phone", "str", "V.PHONE").col("PHONE").len(15).pat("[0-9+ -]{7,15}", "Enter a valid phone number."));
        vs.add(F("in_time", "Check-in", "datetime", "V.IN_TIME").col("IN_TIME").def("SYSDATE").help("Leave empty to use the current time"));
        vs.add(F("out_time", "Check-out", "datetime", "V.OUT_TIME").col("OUT_TIME"));
        vs.add(F("presence", "Status", "str", "(CASE WHEN V.OUT_TIME IS NULL THEN 'Inside' ELSE 'Left' END)").noForm().opts("Inside", "Left").filter());
        vs.search("visitor_name", "student_name", "phone");
        vs.sort("in_time", "desc");
        vs.check = (c, v, id) -> {
            Object in = v.get("in_time"), out = v.get("out_time");
            if (in != null && out != null && out.toString().compareTo(in.toString()) < 0) throw bad("Check-out cannot be before check-in.");
        };
        TABLES.put(vs.key, vs);

        // ---- leave requests
        TableDef lv = new TableDef("leaves", "Leave Requests", "LEAVE_REQUEST", "LEAVE_REQUEST L JOIN STUDENT S ON S.STUDENT_ID = L.STUDENT_ID", "leave_id", "L.LEAVE_ID", "SEQ_LEAVE");
        lv.add(F("leave_id", "ID", "int", "L.LEAVE_ID").noForm());
        lv.add(F("student_id", "Student", "int", "L.STUDENT_ID").col("STUDENT_ID").req().ref("students").filter().noList());
        lv.add(F("student_name", "Student", "str", "S.NAME").noForm());
        lv.add(F("leave_from", "From", "date", "L.LEAVE_FROM").col("LEAVE_FROM").req().range());
        lv.add(F("leave_to", "To", "date", "L.LEAVE_TO").col("LEAVE_TO").req());
        lv.add(F("reason", "Reason", "text", "L.REASON").col("REASON").req().len(200));
        lv.add(F("status", "Status", "str", "L.STATUS").col("STATUS").noForm().def("'Pending'").opts("Pending", "Approved", "Rejected").filter());
        lv.add(F("applied_on", "Applied On", "date", "L.APPLIED_ON").col("APPLIED_ON").noForm().def("SYSDATE"));
        lv.search("student_name", "reason");
        lv.sort("leave_id", "desc");
        lv.check = (c, v, id) -> {
            Object a = v.get("leave_from"), b = v.get("leave_to");
            if (a != null && b != null && b.toString().compareTo(a.toString()) < 0) throw bad("Leave end date cannot be before the start date.");
        };
        TABLES.put(lv.key, lv);

        // ---- inventory
        TableDef inv = new TableDef("inventory", "Room Inventory", "INVENTORY", "INVENTORY I JOIN ROOM R ON R.ROOM_NO = I.ROOM_NO", "item_id", "I.ITEM_ID", "SEQ_ITEM");
        inv.add(F("item_id", "ID", "int", "I.ITEM_ID").noForm());
        inv.add(F("room_no", "Room", "int", "I.ROOM_NO").col("ROOM_NO").req().ref("rooms").filter());
        inv.add(F("block", "Block", "str", "R.BLOCK").noForm().filter().ref("blocks"));
        inv.add(F("item_name", "Item", "str", "I.ITEM_NAME").col("ITEM_NAME").req().len(40));
        inv.add(F("quantity", "Qty", "int", "I.QUANTITY").col("QUANTITY").req().min(0).max(999));
        inv.add(F("item_condition", "Condition", "str", "I.ITEM_CONDITION").col("ITEM_CONDITION").req().opts("Good", "Needs Repair", "Damaged").filter());
        inv.add(F("last_checked", "Last Checked", "date", "I.LAST_CHECKED").col("LAST_CHECKED").range());
        inv.search("item_name", "room_no", "block");
        inv.flag("attention", "Needs attention", "I.ITEM_CONDITION <> 'Good'");
        inv.sort("room_no", "asc");
        TABLES.put(inv.key, inv);

        // ---- notices
        TableDef nt = new TableDef("notices", "Notice Board", "NOTICE", "NOTICE N", "notice_id", "N.NOTICE_ID", "SEQ_NOTICE");
        nt.add(F("notice_id", "ID", "int", "N.NOTICE_ID").noForm());
        nt.add(F("title", "Title", "str", "N.TITLE").col("TITLE").req().len(80));
        nt.add(F("body", "Message", "text", "N.BODY").col("BODY").req().len(1000));
        nt.add(F("priority", "Priority", "str", "N.PRIORITY").col("PRIORITY").opts("Normal", "Important", "Urgent").def("'Normal'").filter());
        nt.add(F("posted_by", "Posted By", "str", "N.POSTED_BY").col("POSTED_BY").auto());
        nt.add(F("posted_on", "Posted On", "date", "N.POSTED_ON").col("POSTED_ON").noForm().def("SYSDATE").range());
        nt.search("title", "body");
        nt.sort("notice_id", "desc");
        TABLES.put(nt.key, nt);

        // ---- audit log (read only)
        TableDef au = new TableDef("audit", "Audit Log", "AUDIT_LOG", "AUDIT_LOG A", "log_id", "A.LOG_ID", null);
        au.readOnly = true; au.adminOnly = true;
        au.add(F("log_id", "ID", "int", "A.LOG_ID"));
        au.add(F("log_time", "When", "datetime", "A.LOG_TIME").range());
        au.add(F("username", "User", "str", "A.USERNAME").filter().ref("users"));
        au.add(F("action", "Action", "str", "A.ACTION").opts("CREATE", "UPDATE", "DELETE", "ALLOT", "VACATE", "PAY", "STATUS", "CHECKOUT", "DECISION", "GENERATE", "PASSWORD").filter());
        au.add(F("table_name", "Table", "str", "A.TABLE_NAME").filter());
        au.add(F("detail", "Detail", "text", "A.DETAIL"));
        au.search("username", "action", "table_name", "detail");
        au.sort("log_id", "desc");
        TABLES.put(au.key, au);
    }

    // ============================================================ meta
    static Object meta(Req r) {
        boolean admin = r.s.role.equals("ADMIN");
        Map<String, Object> tables = new LinkedHashMap<>();
        for (TableDef t : TABLES.values()) {
            if (t.adminOnly && !admin) continue;
            List<Object> fl = new ArrayList<>();
            for (Field f : t.fields) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("key", f.key); m.put("label", f.label); m.put("type", f.type);
                m.put("required", f.required); m.put("list", f.list);
                m.put("form", f.form && f.col != null); m.put("createOnly", f.createOnly);
                m.put("filter", f.filter); m.put("range", f.range);
                if (f.options != null) m.put("options", f.options);
                if (f.ref != null) m.put("ref", f.ref);
                if (f.min != null) m.put("min", f.min);
                if (f.max != null) m.put("max", f.max);
                if (f.maxLen != null) m.put("maxLen", f.maxLen);
                if (f.help != null) m.put("help", f.help);
                fl.add(m);
            }
            List<Object> flags = new ArrayList<>();
            for (Map.Entry<String, String[]> e : t.flags.entrySet()) flags.add(map("key", e.getKey(), "label", e.getValue()[0]));
            tables.put(t.key, map("key", t.key, "title", t.title, "pk", t.pk, "readOnly", t.readOnly,
                "searchable", !t.search.isEmpty(), "defaultSort", t.defaultSort, "defaultDir", t.defaultDir,
                "fields", fl, "flags", flags));
        }
        return map("user", map("username", r.s.user, "role", r.s.role), "tables", tables);
    }

    // ============================================================ generic table routes
    static Object tableRoute(Req r, TableDef t) throws Exception {
        List<String> sg = r.seg;
        String m = r.method;
        String user = r.s.user;

        if (sg.size() == 2) {
            if (m.equals("GET")) return db(c -> list(c, t, r.q));
            if (m.equals("POST") && !t.readOnly) {
                Map<String, Object> body = r.body();
                return tx(c -> create(c, t, body, user));
            }
            throw new ApiException(405, "Method not allowed.");
        }
        String idStr = sg.get(2);
        if (t.key.equals("fees") && idStr.equals("generate") && sg.size() == 3) {
            if (!m.equals("POST")) throw new ApiException(405, "Method not allowed.");
            return generateFees(r);
        }
        if (sg.size() == 3) {
            if (t.readOnly && !m.equals("GET")) throw new ApiException(405, "Read only.");
            if (m.equals("GET")) {
                long id = idOf(idStr);
                Map<String, Object> row = db(c -> one(c, "SELECT " + t.selectList() + " FROM " + t.from + " WHERE " + t.pkSql + " = ?", id));
                if (row == null) throw new ApiException(404, "Record not found.");
                return row;
            }
            if (m.equals("PUT")) {
                long id = idOf(idStr);
                Map<String, Object> body = r.body();
                return tx(c -> update(c, t, id, body, user));
            }
            if (m.equals("DELETE")) {
                long id = idOf(idStr);
                return tx(c -> delete(c, t, id, user));
            }
            throw new ApiException(405, "Method not allowed.");
        }
        // /api/{table}/{id}/{action}  or  /api/fees/generate
        if (!m.equals("POST")) throw new ApiException(405, "Method not allowed.");
        if (sg.size() == 4) return action(r, t, idOf(idStr), sg.get(3));
        throw new ApiException(404, "Unknown action.");
    }

    static String escLike(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    static boolean isDate(String s) {
        try { LocalDate.parse(s); return s.matches("\\d{4}-\\d{2}-\\d{2}"); } catch (Exception e) { return false; }
    }

    static Object filterValue(Field f, String v) {
        try {
            if (f.type.equals("int")) return Long.parseLong(v.trim());
            if (f.type.equals("num")) return new BigDecimal(v.trim());
        } catch (NumberFormatException e) { throw bad("Invalid value for " + f.label + "."); }
        return v;
    }

    static Map<String, Object> list(Connection c, TableDef t, Map<String, String> q) throws SQLException {
        StringBuilder where = new StringBuilder(" WHERE 1 = 1");
        List<Object> ps = new ArrayList<>();

        String s = q.getOrDefault("q", "").trim();
        if (!s.isEmpty() && !t.search.isEmpty()) {
            where.append(" AND (");
            boolean first = true;
            for (String k : t.search) {
                Field f = t.field(k);
                if (!first) where.append(" OR ");
                first = false;
                String x = (f.type.equals("int") || f.type.equals("num")) ? "TO_CHAR(" + f.sql + ")" : f.sql;
                where.append("UPPER(").append(x).append(") LIKE ? ESCAPE '\\'");
                ps.add("%" + escLike(s.toUpperCase()) + "%");
            }
            where.append(")");
        }
        for (Field f : t.fields) {
            if (f.filter) {
                String v = q.get("f_" + f.key);
                if (v != null && !v.isEmpty()) {
                    where.append(" AND ").append(f.sql).append(" = ?");
                    ps.add(filterValue(f, v));
                }
            }
            if (f.range) {
                String lo = q.get(f.key + "_min"), hi = q.get(f.key + "_max");
                boolean isDt = f.type.equals("date") || f.type.equals("datetime");
                if (lo != null && !lo.isEmpty()) {
                    if (isDt) {
                        if (!isDate(lo)) throw bad("Invalid date.");
                        where.append(" AND ").append(f.sql).append(" >= TO_DATE(?, 'YYYY-MM-DD')");
                        ps.add(lo);
                    } else { where.append(" AND ").append(f.sql).append(" >= ?"); ps.add(filterValue(f, lo)); }
                }
                if (hi != null && !hi.isEmpty()) {
                    if (isDt) {
                        if (!isDate(hi)) throw bad("Invalid date.");
                        where.append(" AND ").append(f.sql).append(" < TO_DATE(?, 'YYYY-MM-DD') + 1");
                        ps.add(hi);
                    } else { where.append(" AND ").append(f.sql).append(" <= ?"); ps.add(filterValue(f, hi)); }
                }
            }
        }
        for (Map.Entry<String, String[]> e : t.flags.entrySet())
            if ("1".equals(q.get("flag_" + e.getKey()))) where.append(" AND (").append(e.getValue()[1]).append(")");

        String sortKey = q.getOrDefault("sort", t.defaultSort);
        Field sf = t.field(sortKey);
        if (sf == null) { sf = t.field(t.defaultSort); }
        String dir = "desc".equalsIgnoreCase(q.getOrDefault("dir", t.defaultDir)) ? "DESC" : "ASC";
        String order = " ORDER BY " + sf.sql + " " + dir + " NULLS LAST, " + t.pkSql + " " + dir;

        boolean export = "1".equals(q.get("export"));
        int size = 10, page = 1;
        try { size = Integer.parseInt(q.getOrDefault("size", "10")); } catch (NumberFormatException ignore) { }
        try { page = Integer.parseInt(q.getOrDefault("page", "1")); } catch (NumberFormatException ignore) { }
        size = Math.max(1, Math.min(size, export ? 10000 : 100));
        page = Math.max(1, page);

        long total = num(c, "SELECT COUNT(*) FROM " + t.from + where, ps.toArray());
        String inner = "SELECT " + t.selectList() + " FROM " + t.from + where + order;
        String paged = "SELECT * FROM (SELECT x.*, ROWNUM rn__ FROM (" + inner + ") x WHERE ROWNUM <= ?) WHERE rn__ > ?";
        List<Object> ps2 = new ArrayList<>(ps);
        ps2.add((long) page * size);
        ps2.add((long) (page - 1) * size);
        List<Map<String, Object>> data = rows(c, paged, ps2.toArray());
        return map("rows", data, "total", total, "page", page, "size", size,
                   "pages", Math.max(1, (total + size - 1) / size));
    }

    /** validates the request body against the field rules; returns key -> typed value */
    static Map<Field, Object> validate(TableDef t, Map<String, Object> body, boolean creating) {
        Map<Field, Object> out = new LinkedHashMap<>();
        for (Field f : t.fields) {
            if (f.col == null || !f.form) continue;
            if (!creating && f.createOnly) continue;
            if (!creating && !body.containsKey(f.key)) continue;
            String s = text(body, f.key);
            if (s.isEmpty()) {
                if (f.required) throw bad(f.label + " is required.");
                out.put(f, null);
                continue;
            }
            switch (f.type) {
                case "int": {
                    if (!s.matches("-?\\d{1,9}")) throw bad(f.label + " must be a whole number.");
                    long v = Long.parseLong(s);
                    if (f.min != null && v < f.min) throw bad(f.label + " must be at least " + f.min.longValue() + ".");
                    if (f.max != null && v > f.max) throw bad(f.label + " must be at most " + f.max.longValue() + ".");
                    out.put(f, v);
                    break;
                }
                case "num": {
                    if (!s.matches("\\d{1,8}(\\.\\d{1,2})?")) throw bad(f.label + " must be a number (up to 2 decimals).");
                    BigDecimal v = new BigDecimal(s);
                    if (f.min != null && v.doubleValue() < f.min) throw bad(f.label + " must be at least " + f.min.longValue() + ".");
                    if (f.max != null && v.doubleValue() > f.max) throw bad(f.label + " is too large.");
                    out.put(f, v);
                    break;
                }
                case "date": {
                    if (!isDate(s)) throw bad(f.label + " must be a valid date.");
                    out.put(f, s);
                    break;
                }
                case "datetime": {
                    String v = s.replace('T', ' ');
                    if (v.length() == 16 && v.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}")) {
                        try { LocalDateTime.parse(v.replace(' ', 'T')); } catch (Exception e) { throw bad(f.label + " must be a valid date and time."); }
                    } else throw bad(f.label + " must be a valid date and time.");
                    out.put(f, v);
                    break;
                }
                default: {
                    if (f.maxLen != null && s.length() > f.maxLen) throw bad(f.label + " can have at most " + f.maxLen + " characters.");
                    if (f.options != null) {
                        String hit = null;
                        for (String o : f.options) if (o.equalsIgnoreCase(s)) hit = o;
                        if (hit == null) throw bad(f.label + " must be one of: " + String.join(", ", f.options) + ".");
                        s = hit;
                    }
                    if (f.pattern != null && !s.matches(f.pattern)) throw bad(f.patternHint != null ? f.patternHint : f.label + " is not valid.");
                    out.put(f, s);
                }
            }
        }
        return out;
    }

    static String placeholder(Field f) {
        if (f.type.equals("date")) return "TO_DATE(?, 'YYYY-MM-DD')";
        if (f.type.equals("datetime")) return "TO_DATE(?, 'YYYY-MM-DD HH24:MI')";
        return "?";
    }

    static Map<String, Object> byKey(Map<Field, Object> vals) {
        Map<String, Object> m = new HashMap<>();
        for (Map.Entry<Field, Object> e : vals.entrySet()) m.put(e.getKey().key, e.getValue());
        return m;
    }

    static String describe(Map<Field, Object> vals) {
        StringBuilder b = new StringBuilder();
        for (Map.Entry<Field, Object> e : vals.entrySet()) {
            if (e.getValue() == null || e.getKey().type.equals("text")) continue;
            if (b.length() > 0) b.append(", ");
            b.append(e.getKey().label).append("=").append(e.getValue());
            if (b.length() > 160) break;
        }
        return b.toString();
    }

    static Object create(Connection c, TableDef t, Map<String, Object> body, String user) throws Exception {
        Map<Field, Object> vals = validate(t, body, true);
        if (t.check != null) t.check.run(c, byKey(vals), null);
        List<String> cols = new ArrayList<>(), ph = new ArrayList<>();
        List<Object> ps = new ArrayList<>();
        long id;
        if (t.seq != null) {
            id = nextVal(c, t.seq);
            cols.add(t.pkCol()); ph.add("?"); ps.add(id);
        } else {
            id = ((Number) vals.get(t.field(t.pk))).longValue();
        }
        for (Field f : t.fields) {
            if (f.col == null) continue;
            if (f.autoUser) { cols.add(f.col); ph.add("?"); ps.add(user); continue; }
            Object v = f.form ? vals.get(f) : null;
            if (v != null) { cols.add(f.col); ph.add(placeholder(f)); ps.add(v); }
            else if (f.defaultSql != null) { cols.add(f.col); ph.add(f.defaultSql); }
        }
        exec(c, "INSERT INTO " + t.dbName + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", ph) + ")", ps.toArray());
        audit(c, user, "CREATE", t.dbName, "#" + id + " " + describe(vals));
        return map("ok", true, "id", id);
    }

    static Object update(Connection c, TableDef t, long id, Map<String, Object> body, String user) throws Exception {
        Map<Field, Object> vals = validate(t, body, false);
        if (num(c, "SELECT COUNT(*) FROM " + t.dbName + " WHERE " + t.pkCol() + " = ?", id) == 0)
            throw new ApiException(404, "Record not found.");
        if (t.check != null) t.check.run(c, byKey(vals), id);
        if (vals.isEmpty()) throw bad("Nothing to update.");
        List<String> sets = new ArrayList<>();
        List<Object> ps = new ArrayList<>();
        for (Map.Entry<Field, Object> e : vals.entrySet()) {
            Field f = e.getKey();
            if (e.getValue() == null) {
                sets.add(f.col + " = " + (f.defaultSql != null ? f.defaultSql : "NULL"));
            } else { sets.add(f.col + " = " + placeholder(f)); ps.add(e.getValue()); }
        }
        ps.add(id);
        exec(c, "UPDATE " + t.dbName + " SET " + String.join(", ", sets) + " WHERE " + t.pkCol() + " = ?", ps.toArray());
        audit(c, user, "UPDATE", t.dbName, "#" + id + " " + describe(vals));
        return map("ok", true);
    }

    static Object delete(Connection c, TableDef t, long id, String user) throws Exception {
        Map<String, Object> row = one(c, "SELECT " + t.selectList() + " FROM " + t.from + " WHERE " + t.pkSql + " = ?", id);
        if (row == null) throw new ApiException(404, "Record not found.");
        if (t.beforeDelete != null) t.beforeDelete.run(c, id);
        exec(c, "DELETE FROM " + t.dbName + " WHERE " + t.pkCol() + " = ?", id);
        StringBuilder d = new StringBuilder("#" + id);
        for (Field f : t.fields) {
            Object v = row.get(f.key);
            if (v != null && f.list && (f.type.equals("str")) && d.length() < 120) d.append(' ').append(v);
        }
        audit(c, user, "DELETE", t.dbName, d.toString());
        return map("ok", true);
    }

    // ============================================================ special actions
    static Object action(Req r, TableDef t, long id, String act) throws Exception {
        String user = r.s.user;
        Map<String, Object> b = r.body();
        switch (t.key + "/" + act) {
            case "students/allot": {
                if (text(b, "room_no").isEmpty()) throw bad("Choose a room.");
                long room = idOf(text(b, "room_no"));
                return tx(c -> {
                    Map<String, Object> s = one(c, "SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ? FOR UPDATE", id);
                    if (s == null) throw new ApiException(404, "Student not found.");
                    Object old = s.get("room_no");
                    if (old != null && ((Number) old).longValue() == room) throw bad("The student is already in that room.");
                    Map<String, Object> rm = one(c, "SELECT CAPACITY, OCCUPIED FROM ROOM WHERE ROOM_NO = ? FOR UPDATE", room);
                    if (rm == null) throw bad("That room does not exist.");
                    if (((Number) rm.get("occupied")).longValue() >= ((Number) rm.get("capacity")).longValue())
                        throw new ApiException(409, "Room " + room + " is full.");
                    if (old != null) exec(c, "UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?", old);
                    exec(c, "UPDATE ROOM SET OCCUPIED = OCCUPIED + 1 WHERE ROOM_NO = ?", room);
                    exec(c, "UPDATE STUDENT SET ROOM_NO = ? WHERE STUDENT_ID = ?", room, id);
                    audit(c, user, "ALLOT", "STUDENT", "student #" + id + " -> room " + room + (old != null ? " (from " + old + ")" : ""));
                    return map("ok", true);
                });
            }
            case "students/vacate":
                return tx(c -> {
                    Map<String, Object> s = one(c, "SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ? FOR UPDATE", id);
                    if (s == null) throw new ApiException(404, "Student not found.");
                    if (s.get("room_no") == null) throw bad("The student has no room.");
                    exec(c, "UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?", s.get("room_no"));
                    exec(c, "UPDATE STUDENT SET ROOM_NO = NULL WHERE STUDENT_ID = ?", id);
                    audit(c, user, "VACATE", "STUDENT", "student #" + id + " left room " + s.get("room_no"));
                    return map("ok", true);
                });
            case "fees/pay": {
                String mode = text(b, "pay_mode");
                String hit = null;
                for (String o : new String[]{"Cash", "UPI", "Card", "Net Banking"}) if (o.equalsIgnoreCase(mode)) hit = o;
                if (hit == null) throw bad("Choose a payment mode.");
                final String pm = hit;
                return tx(c -> {
                    int n = exec(c, "UPDATE FEE SET PAID_DATE = TRUNC(SYSDATE), PAY_MODE = ? WHERE FEE_ID = ? AND PAID_DATE IS NULL", pm, id);
                    if (n == 0) throw new ApiException(409, "This fee is already paid (or does not exist).");
                    audit(c, user, "PAY", "FEE", "fee #" + id + " paid by " + pm);
                    return map("ok", true);
                });
            }
            case "complaints/status": {
                String st = text(b, "status");
                String hit = null;
                for (String o : new String[]{"Open", "In Progress", "Resolved"}) if (o.equalsIgnoreCase(st)) hit = o;
                if (hit == null) throw bad("Status must be Open, In Progress or Resolved.");
                final String ns = hit;
                return tx(c -> {
                    int n = exec(c, "UPDATE COMPLAINT SET STATUS = ?, RESOLVED_ON = CASE WHEN ? = 'Resolved' THEN TRUNC(SYSDATE) ELSE NULL END WHERE COMPLAINT_ID = ?", ns, ns, id);
                    if (n == 0) throw new ApiException(404, "Complaint not found.");
                    audit(c, user, "STATUS", "COMPLAINT", "complaint #" + id + " -> " + ns);
                    return map("ok", true);
                });
            }
            case "visitors/checkout":
                return tx(c -> {
                    int n = exec(c, "UPDATE VISITOR SET OUT_TIME = SYSDATE WHERE VISITOR_ID = ? AND OUT_TIME IS NULL", id);
                    if (n == 0) throw new ApiException(409, "Visitor already checked out (or does not exist).");
                    audit(c, user, "CHECKOUT", "VISITOR", "visitor #" + id);
                    return map("ok", true);
                });
            case "leaves/decision": {
                String st = text(b, "status");
                String hit = st.equalsIgnoreCase("Approved") ? "Approved" : st.equalsIgnoreCase("Rejected") ? "Rejected" : null;
                if (hit == null) throw bad("Decision must be Approved or Rejected.");
                final String ns = hit;
                return tx(c -> {
                    int n = exec(c, "UPDATE LEAVE_REQUEST SET STATUS = ? WHERE LEAVE_ID = ? AND STATUS = 'Pending'", ns, id);
                    if (n == 0) throw new ApiException(409, "This request was already decided (or does not exist).");
                    audit(c, user, "DECISION", "LEAVE_REQUEST", "leave #" + id + " " + ns);
                    return map("ok", true);
                });
            }
            default:
                throw new ApiException(404, "Unknown action.");
        }
    }

    /** POST /api/fees/generate : bill every student that has a room (batch insert) */
    static Object generateFees(Req r) throws Exception {
        Map<String, Object> b = r.body();
        String type = text(b, "fee_type"), due = text(b, "due_date");
        boolean useRent = Boolean.TRUE.equals(b.get("use_room_rent"));
        String hit = null;
        for (String o : new String[]{"Room Rent", "Mess", "Maintenance", "Fine", "Other"}) if (o.equalsIgnoreCase(type)) hit = o;
        if (hit == null) throw bad("Choose a fee type.");
        final String ft = hit;
        if (!isDate(due)) throw bad("Choose a valid due date.");
        BigDecimal amt = null;
        if (!useRent) {
            String a = text(b, "amount");
            if (!a.matches("\\d{1,8}(\\.\\d{1,2})?") || new BigDecimal(a).signum() <= 0) throw bad("Enter a valid amount.");
            amt = new BigDecimal(a);
        }
        final BigDecimal fixed = amt;
        String user = r.s.user;
        return tx(c -> {
            List<Map<String, Object>> targets = rows(c,
                "SELECT S.STUDENT_ID, R.RENT FROM STUDENT S JOIN ROOM R ON R.ROOM_NO = S.ROOM_NO " +
                "WHERE NOT EXISTS (SELECT 1 FROM FEE F WHERE F.STUDENT_ID = S.STUDENT_ID AND F.FEE_TYPE = ? AND F.DUE_DATE = TO_DATE(?, 'YYYY-MM-DD')) " +
                "ORDER BY S.STUDENT_ID", ft, due);
            int n = 0;
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO FEE (FEE_ID, STUDENT_ID, FEE_TYPE, AMOUNT, DUE_DATE) VALUES (SEQ_FEE.NEXTVAL, ?, ?, ?, TO_DATE(?, 'YYYY-MM-DD'))")) {
                for (Map<String, Object> t : targets) {
                    ps.setObject(1, t.get("student_id"));
                    ps.setString(2, ft);
                    ps.setBigDecimal(3, fixed != null ? fixed : new BigDecimal(String.valueOf(t.get("rent"))));
                    ps.setString(4, due);
                    ps.addBatch();
                    n++;
                }
                if (n > 0) ps.executeBatch();
            }
            audit(c, user, "GENERATE", "FEE", n + " x " + ft + " due " + due);
            return map("ok", true, "created", n);
        });
    }

    // ============================================================ lookups & search
    static Object lookup(Connection c, String what) throws SQLException {
        switch (what) {
            case "rooms": {
                List<Object> out = new ArrayList<>();
                for (Map<String, Object> m : rows(c, "SELECT ROOM_NO, BLOCK, CAPACITY, OCCUPIED FROM ROOM ORDER BY ROOM_NO")) {
                    long free = ((Number) m.get("capacity")).longValue() - ((Number) m.get("occupied")).longValue();
                    out.add(map("id", m.get("room_no"), "label", m.get("room_no") + " - " + m.get("block"), "free", free));
                }
                return out;
            }
            case "students": {
                List<Object> out = new ArrayList<>();
                for (Map<String, Object> m : rows(c, "SELECT STUDENT_ID, NAME, REG_NO, ROOM_NO FROM STUDENT ORDER BY NAME"))
                    out.add(map("id", m.get("student_id"), "label", m.get("name") + " (" + m.get("reg_no") + ")", "room_no", m.get("room_no")));
                return out;
            }
            case "blocks": {
                List<Object> out = new ArrayList<>();
                for (List<Object> g : grid(c, "SELECT DISTINCT BLOCK FROM ROOM ORDER BY BLOCK")) out.add(map("id", g.get(0), "label", g.get(0)));
                return out;
            }
            case "users": {
                List<Object> out = new ArrayList<>();
                for (List<Object> g : grid(c, "SELECT USERNAME FROM APP_USER ORDER BY USERNAME")) out.add(map("id", g.get(0), "label", g.get(0)));
                return out;
            }
            default: throw new ApiException(404, "Unknown lookup.");
        }
    }

    static Object search(Connection c, String q) throws SQLException {
        if (q.length() < 2) return map("results", new ArrayList<>());
        String like = "%" + escLike(q.toUpperCase()) + "%";
        String sql =
            "SELECT * FROM (" +
            "SELECT 'students' kind, STUDENT_ID id, NAME label, REG_NO sub FROM STUDENT WHERE UPPER(NAME) LIKE ? ESCAPE '\\' OR UPPER(REG_NO) LIKE ? ESCAPE '\\' " +
            "UNION ALL SELECT 'rooms', ROOM_NO, 'Room ' || ROOM_NO, BLOCK FROM ROOM WHERE UPPER(TO_CHAR(ROOM_NO)) LIKE ? ESCAPE '\\' OR UPPER(BLOCK) LIKE ? ESCAPE '\\' " +
            "UNION ALL SELECT 'wardens', WARDEN_ID, NAME, BLOCK FROM WARDEN WHERE UPPER(NAME) LIKE ? ESCAPE '\\' " +
            "UNION ALL SELECT 'complaints', COMPLAINT_ID, CATEGORY, SUBSTR(DESCRIPTION, 1, 60) FROM COMPLAINT WHERE UPPER(DESCRIPTION) LIKE ? ESCAPE '\\' OR UPPER(CATEGORY) LIKE ? ESCAPE '\\' " +
            "UNION ALL SELECT 'notices', NOTICE_ID, TITLE, PRIORITY FROM NOTICE WHERE UPPER(TITLE) LIKE ? ESCAPE '\\'" +
            ") WHERE ROWNUM <= 12";
        return map("results", rows(c, sql, like, like, like, like, like, like, like, like));
    }

    // ============================================================ dashboard
    static Object dashboard(Connection c, boolean admin) throws SQLException {
        Map<String, Object> d = new LinkedHashMap<>();
        Map<String, Object> rm = one(c, "SELECT COUNT(*) rooms, NVL(SUM(CAPACITY), 0) capacity, NVL(SUM(OCCUPIED), 0) occupied FROM ROOM");
        Map<String, Object> sd = one(c, "SELECT COUNT(*) total, NVL(SUM(CASE WHEN ROOM_NO IS NULL THEN 1 ELSE 0 END), 0) unallotted FROM STUDENT");
        Map<String, Object> fe = one(c,
            "SELECT NVL(SUM(CASE WHEN PAID_DATE IS NULL THEN AMOUNT ELSE 0 END), 0) pending, " +
            "NVL(SUM(CASE WHEN PAID_DATE IS NOT NULL THEN AMOUNT ELSE 0 END), 0) collected, " +
            "NVL(SUM(CASE WHEN PAID_DATE IS NULL AND DUE_DATE < TRUNC(SYSDATE) THEN AMOUNT ELSE 0 END), 0) overdue, " +
            "NVL(SUM(CASE WHEN PAID_DATE IS NULL AND DUE_DATE < TRUNC(SYSDATE) THEN 1 ELSE 0 END), 0) overdue_count FROM FEE");
        long cap = ((Number) rm.get("capacity")).longValue(), occ = ((Number) rm.get("occupied")).longValue();
        Map<String, Object> k = new LinkedHashMap<>();
        k.put("rooms", rm.get("rooms"));
        k.put("capacity", cap);
        k.put("occupied", occ);
        k.put("vacant", cap - occ);
        k.put("occupancy", cap == 0 ? 0 : Math.round(occ * 1000.0 / cap) / 10.0);
        k.put("students", sd.get("total"));
        k.put("unallotted", sd.get("unallotted"));
        k.put("wardens", num(c, "SELECT COUNT(*) FROM WARDEN"));
        k.put("fees_pending", fe.get("pending"));
        k.put("fees_collected", fe.get("collected"));
        k.put("fees_overdue", fe.get("overdue"));
        k.put("fees_overdue_count", fe.get("overdue_count"));
        k.put("complaints_open", num(c, "SELECT COUNT(*) FROM COMPLAINT WHERE STATUS <> 'Resolved'"));
        k.put("visitors_inside", num(c, "SELECT COUNT(*) FROM VISITOR WHERE OUT_TIME IS NULL"));
        k.put("leaves_pending", num(c, "SELECT COUNT(*) FROM LEAVE_REQUEST WHERE STATUS = 'Pending'"));
        k.put("items_attention", num(c, "SELECT COUNT(*) FROM INVENTORY WHERE ITEM_CONDITION <> 'Good'"));
        d.put("kpis", k);

        d.put("occupancy_by_block", rows(c, "SELECT BLOCK, SUM(CAPACITY) capacity, SUM(OCCUPIED) occupied FROM ROOM GROUP BY BLOCK ORDER BY BLOCK"));
        d.put("complaints_by_status", rows(c, "SELECT STATUS label, COUNT(*) cnt FROM COMPLAINT GROUP BY STATUS ORDER BY STATUS"));
        d.put("students_by_dept", rows(c, "SELECT DEPARTMENT label, COUNT(*) cnt FROM STUDENT GROUP BY DEPARTMENT ORDER BY 2 DESC, 1"));
        d.put("fees_by_status", Arrays.asList(
            map("label", "Paid", "cnt", fe.get("collected")),
            map("label", "Pending", "cnt", ((Number) fe.get("pending")).doubleValue() - ((Number) fe.get("overdue")).doubleValue()),
            map("label", "Overdue", "cnt", fe.get("overdue"))));

        // fee collection for the last 6 months (months filled in Java)
        LocalDate first = LocalDate.now().withDayOfMonth(1).minusMonths(5);
        Map<String, Double> byMonth = new LinkedHashMap<>();
        for (int i = 0; i < 6; i++) byMonth.put(first.plusMonths(i).toString().substring(0, 7), 0.0);
        for (List<Object> g : grid(c, "SELECT TO_CHAR(PAID_DATE, 'YYYY-MM'), SUM(AMOUNT) FROM FEE WHERE PAID_DATE >= TO_DATE(?, 'YYYY-MM-DD') GROUP BY TO_CHAR(PAID_DATE, 'YYYY-MM')", first.toString()))
            if (byMonth.containsKey(String.valueOf(g.get(0)))) byMonth.put(String.valueOf(g.get(0)), ((Number) g.get(1)).doubleValue());
        List<Object> months = new ArrayList<>();
        for (Map.Entry<String, Double> e : byMonth.entrySet()) months.add(map("label", e.getKey(), "cnt", e.getValue()));
        d.put("collection_by_month", months);

        d.put("notices", rows(c, "SELECT * FROM (SELECT NOTICE_ID, TITLE, BODY, PRIORITY, POSTED_BY, TO_CHAR(POSTED_ON, 'YYYY-MM-DD') POSTED_ON FROM NOTICE ORDER BY NOTICE_ID DESC) WHERE ROWNUM <= 4"));
        d.put("overdue_fees", rows(c, "SELECT * FROM (SELECT F.FEE_ID, S.NAME, F.FEE_TYPE, F.AMOUNT, TO_CHAR(F.DUE_DATE, 'YYYY-MM-DD') DUE_DATE FROM FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID WHERE F.PAID_DATE IS NULL AND F.DUE_DATE < TRUNC(SYSDATE) ORDER BY F.DUE_DATE, F.FEE_ID) WHERE ROWNUM <= 5"));
        d.put("open_complaints", rows(c, "SELECT * FROM (SELECT C.COMPLAINT_ID, S.NAME, C.CATEGORY, C.PRIORITY, C.STATUS, SUBSTR(C.DESCRIPTION, 1, 70) DESCRIPTION FROM COMPLAINT C JOIN STUDENT S ON S.STUDENT_ID = C.STUDENT_ID WHERE C.STATUS <> 'Resolved' ORDER BY C.COMPLAINT_ID DESC) WHERE ROWNUM <= 5"));
        d.put("activity", admin
            ? rows(c, "SELECT * FROM (SELECT USERNAME, ACTION, TABLE_NAME, DETAIL, TO_CHAR(LOG_TIME, 'YYYY-MM-DD HH24:MI') LOG_TIME FROM AUDIT_LOG ORDER BY LOG_ID DESC) WHERE ROWNUM <= 6")
            : new ArrayList<>());
        return d;
    }

    // ============================================================ reports
    static Object report(Connection c, String name) throws SQLException {
        String title; String[] cols; List<List<Object>> data;
        switch (name) {
            case "block-summary":
                title = "Block-wise room summary";
                cols = new String[]{"Block", "Rooms", "Capacity", "Occupied", "Vacant", "Occupancy %", "Avg Rent", "Rent Value"};
                data = grid(c, "SELECT BLOCK, COUNT(*), SUM(CAPACITY), SUM(OCCUPIED), SUM(CAPACITY) - SUM(OCCUPIED), " +
                    "ROUND(SUM(OCCUPIED) * 100 / NULLIF(SUM(CAPACITY), 0), 1), ROUND(AVG(RENT), 2), SUM(OCCUPIED * RENT) FROM ROOM GROUP BY BLOCK ORDER BY BLOCK");
                break;
            case "room-vacancy":
                title = "Rooms with vacancies";
                cols = new String[]{"Room", "Block", "Capacity", "Occupied", "Free Beds", "Rent"};
                data = grid(c, "SELECT ROOM_NO, BLOCK, CAPACITY, OCCUPIED, CAPACITY - OCCUPIED, RENT FROM ROOM WHERE OCCUPIED < CAPACITY ORDER BY BLOCK, ROOM_NO");
                break;
            case "room-occupants":
                title = "Who stays where";
                cols = new String[]{"Room", "Block", "Occupied", "Students"};
                data = grid(c, "SELECT R.ROOM_NO, R.BLOCK, R.OCCUPIED, LISTAGG(S.NAME, ', ') WITHIN GROUP (ORDER BY S.NAME) " +
                    "FROM ROOM R LEFT JOIN STUDENT S ON S.ROOM_NO = R.ROOM_NO GROUP BY R.ROOM_NO, R.BLOCK, R.OCCUPIED ORDER BY R.ROOM_NO");
                break;
            case "department-summary":
                title = "Department-wise students";
                cols = new String[]{"Department", "Students", "With Room", "Without Room", "Avg Year"};
                data = grid(c, "SELECT DEPARTMENT, COUNT(*), SUM(CASE WHEN ROOM_NO IS NOT NULL THEN 1 ELSE 0 END), " +
                    "SUM(CASE WHEN ROOM_NO IS NULL THEN 1 ELSE 0 END), ROUND(AVG(YEAR_OF_STUDY), 1) FROM STUDENT GROUP BY DEPARTMENT ORDER BY 2 DESC, 1");
                break;
            case "fee-summary":
                title = "Fee summary by type";
                cols = new String[]{"Fee Type", "Bills", "Billed", "Collected", "Pending"};
                data = grid(c, "SELECT FEE_TYPE, COUNT(*), SUM(AMOUNT), SUM(CASE WHEN PAID_DATE IS NOT NULL THEN AMOUNT ELSE 0 END), " +
                    "SUM(CASE WHEN PAID_DATE IS NULL THEN AMOUNT ELSE 0 END) FROM FEE GROUP BY FEE_TYPE ORDER BY FEE_TYPE");
                break;
            case "fee-defaulters": {
                title = "Fee defaulters (overdue)";
                cols = new String[]{"Student", "Reg No", "Room", "Fee Type", "Amount", "Due Date", "Days Overdue"};
                data = grid(c, "SELECT S.NAME, S.REG_NO, S.ROOM_NO, F.FEE_TYPE, F.AMOUNT, TO_CHAR(F.DUE_DATE, 'YYYY-MM-DD') " +
                    "FROM FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID WHERE F.PAID_DATE IS NULL AND F.DUE_DATE < TRUNC(SYSDATE) ORDER BY F.DUE_DATE, S.NAME");
                LocalDate today = LocalDate.now();
                for (List<Object> row : data)
                    row.add(java.time.temporal.ChronoUnit.DAYS.between(LocalDate.parse(String.valueOf(row.get(5))), today));
                break;
            }
            case "complaint-summary":
                title = "Complaints by category";
                cols = new String[]{"Category", "Total", "Open", "In Progress", "Resolved"};
                data = grid(c, "SELECT CATEGORY, COUNT(*), SUM(CASE WHEN STATUS = 'Open' THEN 1 ELSE 0 END), " +
                    "SUM(CASE WHEN STATUS = 'In Progress' THEN 1 ELSE 0 END), SUM(CASE WHEN STATUS = 'Resolved' THEN 1 ELSE 0 END) " +
                    "FROM COMPLAINT GROUP BY CATEGORY ORDER BY 2 DESC, 1");
                break;
            case "visitor-summary":
                title = "Visitors by relation";
                cols = new String[]{"Relation", "Visits", "Still Inside"};
                data = grid(c, "SELECT NVL(RELATION, 'Other'), COUNT(*), SUM(CASE WHEN OUT_TIME IS NULL THEN 1 ELSE 0 END) FROM VISITOR GROUP BY NVL(RELATION, 'Other') ORDER BY 2 DESC, 1");
                break;
            case "inventory-attention":
                title = "Items needing attention";
                cols = new String[]{"Room", "Block", "Item", "Qty", "Condition", "Last Checked"};
                data = grid(c, "SELECT I.ROOM_NO, R.BLOCK, I.ITEM_NAME, I.QUANTITY, I.ITEM_CONDITION, TO_CHAR(I.LAST_CHECKED, 'YYYY-MM-DD') " +
                    "FROM INVENTORY I JOIN ROOM R ON R.ROOM_NO = I.ROOM_NO WHERE I.ITEM_CONDITION <> 'Good' ORDER BY I.ROOM_NO, I.ITEM_NAME");
                break;
            case "list": {
                List<Object> l = new ArrayList<>();
                String[][] all = {{"block-summary", "Block-wise room summary"}, {"room-vacancy", "Rooms with vacancies"}, {"room-occupants", "Who stays where"},
                    {"department-summary", "Department-wise students"}, {"fee-summary", "Fee summary by type"}, {"fee-defaulters", "Fee defaulters (overdue)"},
                    {"complaint-summary", "Complaints by category"}, {"visitor-summary", "Visitors by relation"}, {"inventory-attention", "Items needing attention"}};
                for (String[] a : all) l.add(map("key", a[0], "title", a[1]));
                return map("reports", l);
            }
            default: throw new ApiException(404, "Unknown report.");
        }
        return map("title", title, "columns", cols, "rows", data);
    }
}
