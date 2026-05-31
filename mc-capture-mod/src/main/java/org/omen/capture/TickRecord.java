package org.omen.capture;

/** DTO d'un tick capturé. Champs publics (POJO simple), rempli par les hooks puis sérialisé. */
public class TickRecord {
    public long t;
    public boolean forward, back, left, right, jump, sneak, sprint, attack, use;
    public double yaw, pitch;
    public double x, y, z, vx, vy, vz;
    public boolean onGround = true;
    public int health = 20, food = 20;
    public String held = "air";
}
