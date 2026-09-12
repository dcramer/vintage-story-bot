namespace VintageStoryAI;

// One walking step as a player takes it: turn to face the point, walk while
// facing it, stop on it. The mod tracks it every game tick so the body ends
// where the step says, whatever the frame rate; Node chooses the point and
// what comes next. Pure: no game objects, so it can be checked without one.
public sealed class StepTracker
{
    public const double AlignDegrees = 20;
    public const double BlockedMs = 700;
    public const double HopDistance = 1.1;
    public const double PassedLateral = 0.6;

    public Point3 Toward { get; }
    public Point3 Start { get; }
    public double Reach { get; }
    public double ReachY { get; }
    // Jump when close and facing the point: a step up or a gap.
    public bool Hop { get; }
    public string State { get; private set; } = "walking";
    public double Distance { get; private set; }
    private double bestDistance = double.PositiveInfinity;
    private long progressAt;

    public StepTracker(Point3 toward, Point3 start, double reach, double reachY, bool hop, long now)
    {
        Toward = toward; Start = start; Reach = reach; ReachY = reachY; Hop = hop; progressAt = now;
        Distance = Horizontal(toward, start);
    }

    private static double Horizontal(Point3 a, Point3 b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Z - b.Z) * (a.Z - b.Z));

    public bool Same(Point3 toward) => Math.Abs(toward.X - Toward.X) < 0.01 && Math.Abs(toward.Y - Toward.Y) < 0.01 && Math.Abs(toward.Z - Toward.Z) < 0.01;

    // What to hold this tick, and where to look. Forward only while facing the point and
    // supported (in the air only a hop keeps it, so a drop falls straight down); jump held
    // in water to keep the head up, or to hop once close.
    public (bool Forward, bool Jump, double Yaw) Update(Point3 position, double yawDegrees, bool onGround, bool wet, long now)
    {
        double dx = Toward.X - position.X, dz = Toward.Z - position.Z;
        Distance = Math.Sqrt(dx * dx + dz * dz);
        double wantYaw = SceneGeometry.Normalize(Math.Atan2(dx, dz) * 180 / Math.PI);
        if (State != "walking") return (false, wet, wantYaw);
        double dy = Toward.Y - position.Y;
        bool level = Math.Abs(dy) <= ReachY;
        // On the point, or past it: the plane through the point across the step has been crossed.
        double sx = Toward.X - Start.X, sz = Toward.Z - Start.Z, length = Math.Sqrt(sx * sx + sz * sz);
        bool passed = length > 0.05 && (dx * sx + dz * sz) / length < 0 && Math.Abs(dx * sz - dz * sx) / length <= PassedLateral;
        // Arrived means standing on it (or afloat at it): a body still in the air has not landed yet.
        if (level && (onGround || wet) && (Distance <= Reach || passed)) { State = "arrived"; return (false, wet, wantYaw); }
        double error = Math.Abs(SceneGeometry.Normalize(wantYaw - yawDegrees + 180) - 180);
        bool aligned = error < AlignDegrees;
        if (Distance < bestDistance - 0.03) { bestDistance = Distance; progressAt = now; }
        // Turning and falling are not being stuck; walking without getting closer is.
        else if (!aligned || (!onGround && !wet)) progressAt = now;
        else if (now - progressAt > BlockedMs) { State = "blocked"; return (false, wet, wantYaw); }
        bool forward = aligned && (onGround || wet || Hop);
        bool jump = wet || (Hop && aligned && Distance < HopDistance);
        return (forward, jump, wantYaw);
    }

    public void Expire() { if (State == "walking") State = "expired"; }

    public object View() => new { state = State, distance = Math.Round(Distance, 2), toward = new { x = Toward.X, y = Toward.Y, z = Toward.Z } };
}
