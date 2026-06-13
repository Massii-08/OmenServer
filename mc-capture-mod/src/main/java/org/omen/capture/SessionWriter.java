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

    private static String num1(double v) { return String.valueOf(Math.round(v * 10.0) / 10.0); }

    // --- Events comportementaux (1b.2) : stimulus/combat/minage → calibration réaction + clips.
    // Types alignés 1:1 sur mc_capture_distill.py (mob_appear/damage = _reaction_times ; attack =
    // contexte 'combat' de segment_clips ; block_break = cadence de minage, futur).

    /** Un hostile entre dans le rayon de vue (stimulus de réaction). */
    public void writeMobAppear(long t, String mob, double dist) {
        writeLine("{\"t\":" + t + ",\"type\":\"mob_appear\",\"mob\":\"" + esc(mob) + "\",\"dist\":" + num1(dist) + "}");
    }

    /** Le joueur encaisse des dégâts (stimulus de réaction). `amount` = PV perdus, `health` = PV restants. */
    public void writeDamage(long t, double amount, int health) {
        writeLine("{\"t\":" + t + ",\"type\":\"damage\",\"amount\":" + num1(amount) + ",\"hp\":" + health + "}");
    }

    /** Le joueur attaque une entité (contexte combat). */
    public void writeAttack(long t, String target) {
        writeLine("{\"t\":" + t + ",\"type\":\"attack\",\"target\":\"" + esc(target) + "\"}");
    }

    /** Le joueur casse un bloc (cadence/pattern de minage). */
    public void writeBlockBreak(long t, String block) {
        writeLine("{\"t\":" + t + ",\"type\":\"block_break\",\"block\":\"" + esc(block) + "\"}");
    }
}
