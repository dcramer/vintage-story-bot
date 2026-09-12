using VintageStoryAI;

static class StepTrackerTests
{
    public static void Run()
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); }
        var toward = new Point3(2.5, 100, 0.5);
        var step = new StepTracker(toward, new Point3(0.5, 100, 0.5), 0.35, 0.6, false, 0);
        // Facing away: turn first, no walking, and turning is never being stuck.
        var turn = step.Update(new Point3(0.5, 100, 0.5), 270, true, false, 0);
        Check(!turn.Forward && Math.Abs(turn.Yaw - 90) < 1e-9, "turn before walking");
        Check(step.Update(new Point3(0.5, 100, 0.5), 270, true, false, 2000).Forward == false && step.State == "walking", "turning is not blocked");
        // Facing it: walk.
        Check(step.Update(new Point3(0.5, 100, 0.5), 85, true, false, 2100).Forward, "walk once facing");
        // On it: arrived, nothing held.
        var done = step.Update(new Point3(2.3, 100, 0.5), 90, true, false, 2500);
        Check(step.State == "arrived" && !done.Forward, "arrived within reach");
        // Past it at speed on a slow tick: still arrived, not chased backwards.
        var fast = new StepTracker(toward, new Point3(0.5, 100, 0.5), 0.35, 0.6, false, 0);
        fast.Update(new Point3(3.2, 100, 0.7), 90, true, false, 100);
        Check(fast.State == "arrived", "passed the point counts as arrived");
        // Walking straight at a wall: blocked after a while without getting closer.
        var wall = new StepTracker(toward, new Point3(0.5, 100, 0.5), 0.35, 0.6, false, 0);
        for (long t = 0; t <= 800; t += 100) wall.Update(new Point3(1.0, 100, 0.5), 90, true, false, t);
        Check(wall.State == "blocked", "no progress while walking is blocked");
        // A hop: jump only close and facing, forward kept in the air; arrival waits for the landing.
        var up = new StepTracker(new Point3(1.5, 101, 0.5), new Point3(0.5, 100, 0.5), 0.35, 0.6, true, 0);
        var far = up.Update(new Point3(0.2, 100, 0.5), 90, true, false, 0);
        Check(far.Forward && !far.Jump, "no jump from afar");
        var near = up.Update(new Point3(0.6, 100, 0.5), 90, true, false, 100);
        Check(near.Forward && near.Jump, "jump close and facing");
        var air = up.Update(new Point3(1.4, 100.6, 0.5), 90, false, false, 200);
        Check(air.Forward && up.State == "walking", "forward through the air, not yet landed");
        up.Update(new Point3(1.5, 101, 0.5), 90, true, false, 400);
        Check(up.State == "arrived", "landed on the cell");
        // A drop: forward released in the air so the body falls onto the cell below.
        var down = new StepTracker(new Point3(1.5, 99, 0.5), new Point3(0.5, 100, 0.5), 0.35, 0.6, false, 0);
        Check(!down.Update(new Point3(1.1, 99.6, 0.5), 90, false, false, 100).Forward, "no forward while falling");
        // Water: jump held to keep the head up; arrival tolerates the float.
        var swim = new StepTracker(new Point3(1.5, 99.5, 0.5), new Point3(0.5, 99.5, 0.5), 0.35, 1.5, false, 0);
        var stroke = swim.Update(new Point3(0.5, 98.6, 0.5), 90, false, true, 0);
        Check(stroke.Forward && stroke.Jump, "swimming holds jump");
        // A step still going after 2.5 s is stuck, even while the distance wobbles about.
        var bounce = new StepTracker(toward, new Point3(0.5, 100, 0.5), 0.35, 0.6, true, 0);
        for (long t = 0; t <= 2600; t += 100) bounce.Update(new Point3(1.0 + (t % 300) / 300.0, 100 + (t % 200) / 100.0, 0.5), 90, t % 200 == 0, false, t);
        Check(bounce.State == "blocked", "an old step is stuck");
        // A queued next point: reaching the first rolls straight on, reporting what was reached.
        var chain = new StepTracker(toward, new Point3(0.5, 100, 0.5), 0.35, 0.6, false, 0);
        chain.Queue(new Point3(4.5, 100, 0.5), false);
        var rolled = chain.Update(new Point3(2.4, 100, 0.5), 90, true, false, 500);
        Check(chain.State == "walking" && chain.Arrived is Point3 && chain.Toward.X == 4.5 && rolled.Forward, "rolls on to the next point");
        Check(chain.Continues(new Point3(2.5, 100, 0.5), new Point3(4.5, 100, 0.5)), "a frame naming the reached point and the current one still describes this step");
        Check(!chain.Continues(new Point3(2.5, 100, 0.5), null), "a frame naming only the reached point does not");
        chain.Queue(new Point3(4.5, 100, 0.5), false);
        Check(chain.Next == null, "the current point is never queued behind itself");
        Console.WriteLine("18 step checks passed.");
    }
}
