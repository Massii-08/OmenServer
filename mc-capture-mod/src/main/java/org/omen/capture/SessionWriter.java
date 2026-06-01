package org.omen.capture;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Sérialisation JSONL PURE (aucune dépendance Minecraft). Écrit le header puis un objet
 * JSON par tick sur l'OutputStream fourni. JSON construit à la main (pas de lib) pour
 * rester sans dépendance et 100% testable.
 */
public class SessionWriter {
    private final OutputStream out;

    public SessionWriter(OutputStream out) { this.out = out; }

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default: b.append(c);
            }
        }
        return b.toString();
    }

    private void writeLine(String json) {
        try {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.write('\n');
            out.flush();
        } catch (IOException e) {
            throw new RuntimeException(e);  // remonté à Recorder → REC-off
        }
    }

    public void writeHeader(String player, String mc, String mod, long startedAt, int sampleHz) {
        writeLine("{\"schema\":1,\"player\":\"" + esc(player) + "\",\"mc\":\"" + esc(mc)
                + "\",\"mod\":\"" + esc(mod) + "\",\"consent\":true,\"startedAt\":" + startedAt
                + ",\"sampleHz\":" + sampleHz + "}");
    }

    private static int b(boolean v) { return v ? 1 : 0; }

    public void writeTick(TickRecord r) {
        writeLine("{\"t\":" + r.t + ",\"type\":\"tick\",\"in\":{"
                + "\"fwd\":" + b(r.forward) + ",\"back\":" + b(r.back) + ",\"left\":" + b(r.left)
                + ",\"right\":" + b(r.right) + ",\"jump\":" + b(r.jump) + ",\"sneak\":" + b(r.sneak)
                + ",\"sprint\":" + b(r.sprint) + ",\"atk\":" + b(r.attack) + ",\"use\":" + b(r.use)
                + "},\"yaw\":" + r.yaw + ",\"pitch\":" + r.pitch
                + ",\"pos\":[" + r.x + "," + r.y + "," + r.z + "]"
                + ",\"vel\":[" + r.vx + "," + r.vy + "," + r.vz + "]"
                + ",\"og\":" + b(r.onGround) + ",\"hp\":" + r.health + ",\"food\":" + r.food
                + ",\"held\":\"" + esc(r.held) + "\"}");
    }

    public void writeChat(long t, String dir, String from, String text, int len) {
        StringBuilder b = new StringBuilder("{\"t\":").append(t)
                .append(",\"type\":\"").append(dir).append("\"");
        if (from != null) b.append(",\"from\":\"").append(esc(from)).append("\"");
        if (text != null) b.append(",\"text\":\"").append(esc(text)).append("\"");
        b.append(",\"len\":").append(len).append("}");
        writeLine(b.toString());
    }
}
