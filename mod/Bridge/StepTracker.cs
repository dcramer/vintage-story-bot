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
    public const double HopDistance = 1.8;
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
    private bool airborneCarry;

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
    // supported or continuing a hop/shallow descent along queued points; jump held
    // in water to keep the head up, or to hop once close.
    public (bool Forward, bool Jump, double Yaw) Update(Point3 position, double yawDegrees, bool onGround, bool wet, long now, bool swimming = false)
    {
        bool buoyant = wet && swimming;
        double dx = Toward.X - position.X, dz = Toward.Z - position.Z;
        Distance = Math.Sqrt(dx * dx + dz * dz);
        double wantYaw = SceneGeometry.Normalize(Math.Atan2(dx, dz) * 180 / Math.PI);
        if (State != "walking") return (false, buoyant, wantYaw);
        double dy = Toward.Y - position.Y;
        bool level = Math.Abs(dy) <= ReachY;
        // On the point, or past it: the plane through the point across the step has been crossed.
        double sx = Toward.X - Start.X, sz = Toward.Z - Start.Z, length = Math.Sqrt(sx * sx + sz * sz);
        bool passed = length > 0.05 && (dx * sx + dz * sz) / length < 0 && Math.Abs(dx * sz - dz * sx) / length <= PassedLateral;
        if (onGround || wet) airborneCarry = false;
        // A queued continuation over level ground or one block down can receive a jump or a shallow descent in stride.
        // Final points, sharp turns, climbs and deep drops still wait for the landing.
        bool carry = false;
        if (Next is Point3 continuation && continuation.Y <= Toward.Y + 0.05 && Toward.Y - continuation.Y <= 1.05 && !NextHop &&
            Start.Y - Toward.Y <= 1.05 && position.Y >= Toward.Y - ReachY && position.Y <= Toward.Y + 1.6)
        {
            double nx = continuation.X - Toward.X, nz = continuation.Z - Toward.Z;
            double nlength = Math.Sqrt(nx * nx + nz * nz);
            carry = length > 0.05 && nlength > 0.05 && (sx * nx + sz * nz) / (length * nlength) > 0.94;
        }
        if ((level && (onGround || wet) || carry && !onGround) && (Distance <= Reach || passed))
        {
            Arrived = Toward;
            if (Next is Point3 next)
            {
                // Roll straight on: the reached point is the new start, no frame from Node needed.
                airborneCarry = !onGround && !wet;
                Start = new Point3(position.X, Toward.Y, position.Z); Toward = next; Hop = NextHop; Next = null;
                bestDistance = double.PositiveInfinity; progressAt = now; startedAt = now;
                dx = Toward.X - position.X; dz = Toward.Z - position.Z; Distance = Math.Sqrt(dx * dx + dz * dz);
                wantYaw = SceneGeometry.Normalize(Math.Atan2(dx, dz) * 180 / Math.PI);
                dy = Toward.Y - position.Y;
                level = Math.Abs(dy) <= ReachY;
                passed = false;
            }
            else { State = "arrived"; return (false, buoyant, wantYaw); }
        }
        double error = Math.Abs(SceneGeometry.Normalize(wantYaw - yawDegrees + 180) - 180);
        // A point with another queued behind it is passed through, not stopped on: the wide gate all the way.
        bool aligned = error < ((Distance > WideAlignDistance || Next is Point3) && !Hop ? WideAlignDegrees : AlignDegrees);
        if (now - startedAt > MaxMs) { State = "blocked"; return (false, buoyant, wantYaw); }
        if (Distance < bestDistance - 0.03) { bestDistance = Distance; progressAt = now; }
        // Turning and falling are not being stuck; walking without getting closer is.
        else if (!aligned || (!onGround && !wet)) progressAt = now;
        else if (now - progressAt > BlockedMs) { State = "blocked"; return (false, buoyant, wantYaw); }
        // Past the point but not yet down on it (the landing of a hop): let the body land rather than
        // run on through the arc. A hop fires only while the point is still above the feet: a body that
        // stepped up onto its level already must not be launched over it.
        bool forward = aligned && (onGround || wet || Hop || carry || airborneCarry) && !(passed && !level && !carry);
        bool jump = buoyant || (Hop && aligned && Distance < HopDistance && dy > ReachY);
        return (forward, jump, wantYaw);
    }

    public void Expire() { if (State == "walking") State = "expired"; }

    public object View() => new { state = State, distance = Math.Round(Distance, 2), toward = new { x = Toward.X, y = Toward.Y, z = Toward.Z },
        arrived = Arrived is Point3 a ? new { x = a.X, y = a.Y, z = a.Z } : null, next = Next is Point3 n ? new { x = n.X, y = n.Y, z = n.Z } : null };
}
