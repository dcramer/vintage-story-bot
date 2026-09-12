namespace VintageStoryAI;

// One walking step as a player takes it: turn to face the point, walk while
// facing it, stop on it. The mod tracks it every game tick so the body ends
// where the step says, whatever the frame rate; Node chooses the point and
// what comes next. Pure: no game objects, so it can be checked without one.
public sealed class StepTracker
{
    public const double AlignDegrees = 20;
    // Farther than a block from the point the body walks while it turns, the way a player rounds a bend;
    // only the last block, and a hop, wait for the head to point at it.
    public const double WideAlignDegrees = 60;
    public const double WideAlignDistance = 1.0;
    public const double BlockedMs = 700;
    public const double HopDistance = 1.1;
    public const double PassedLateral = 0.6;
    // A single step to an adjacent cell that is still going after this long is stuck, however the distance wobbles.
    public const double MaxMs = 2500;

    public Point3 Toward { get; private set; }
    public Point3 Start { get; private set; }
    // The point to roll on to once this one is reached, so a walk does not pause for Node between cells.
    public Point3? Next { get; private set; }
    public bool NextHop { get; private set; }
    // The last point reached, reported so Node can retire it while the body already walks on.
    public Point3? Arrived { get; private set; }
    public double Reach { get; }
    public double ReachY { get; }
    // Jump when close and facing the point: a step up or a gap.
    public bool Hop { get; private set; }
    public string State { get; private set; } = "walking";
    public double Distance { get; private set; }
    private double bestDistance = double.PositiveInfinity;
    private long progressAt;
    private long startedAt;

    public StepTracker(Point3 toward, Point3 start, double reach, double reachY, bool hop, long now)
    {
        Toward = toward; Start = start; Reach = reach; ReachY = reachY; Hop = hop; progressAt = now; startedAt = now;
        Distance = Horizontal(toward, start);
    }

    private static double Horizontal(Point3 a, Point3 b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Z - b.Z) * (a.Z - b.Z));

    private static bool Near(Point3? a, Point3 b) => a is Point3 p && Math.Abs(p.X - b.X) < 0.01 && Math.Abs(p.Y - b.Y) < 0.01 && Math.Abs(p.Z - b.Z) < 0.01;
    public bool Same(Point3 toward) => Near(Toward, toward);
    // A frame still describes this step when it names the current point, or the point just reached
    // with the current one queued behind it (Node has not yet seen the roll-on).
    public bool Continues(Point3 toward, Point3? then) => Same(toward) || (Near(Arrived, toward) && then is Point3 t && Near(Toward, t));
    public void Queue(Point3? next, bool hop) { Next = next is Point3 n && Near(Toward, n) ? null : next; NextHop = hop; }

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
        if (level && (onGround || wet) && (Distance <= Reach || passed))
        {
            Arrived = Toward;
            if (Next is Point3 next)
            {
                // Roll straight on: the reached point is the new start, no frame from Node needed.
                Toward = next; Start = position; Hop = NextHop; Next = null;
                bestDistance = double.PositiveInfinity; progressAt = now; startedAt = now;
                dx = Toward.X - position.X; dz = Toward.Z - position.Z; Distance = Math.Sqrt(dx * dx + dz * dz);
                wantYaw = SceneGeometry.Normalize(Math.Atan2(dx, dz) * 180 / Math.PI);
                double e2 = Math.Abs(SceneGeometry.Normalize(wantYaw - yawDegrees + 180) - 180);
                return (e2 < AlignDegrees, wet, wantYaw);
            }
            State = "arrived"; return (false, wet, wantYaw);
        }
        double error = Math.Abs(SceneGeometry.Normalize(wantYaw - yawDegrees + 180) - 180);
        bool aligned = error < (Distance > WideAlignDistance && !Hop ? WideAlignDegrees : AlignDegrees);
        if (now - startedAt > MaxMs) { State = "blocked"; return (false, wet, wantYaw); }
        if (Distance < bestDistance - 0.03) { bestDistance = Distance; progressAt = now; }
        // Turning and falling are not being stuck; walking without getting closer is.
        else if (!aligned || (!onGround && !wet)) progressAt = now;
        else if (now - progressAt > BlockedMs) { State = "blocked"; return (false, wet, wantYaw); }
        bool forward = aligned && (onGround || wet || Hop);
        bool jump = wet || (Hop && aligned && Distance < HopDistance);
        return (forward, jump, wantYaw);
    }

    public void Expire() { if (State == "walking") State = "expired"; }

    public object View() => new { state = State, distance = Math.Round(Distance, 2), toward = new { x = Toward.X, y = Toward.Y, z = Toward.Z },
        arrived = Arrived is Point3 a ? new { x = a.X, y = a.Y, z = a.Z } : null, next = Next is Point3 n ? new { x = n.X, y = n.Y, z = n.Z } : null };
}
