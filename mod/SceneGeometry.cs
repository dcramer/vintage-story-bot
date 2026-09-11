namespace VintageStoryAI;

public readonly record struct Point3(double X, double Y, double Z);

public static class SceneGeometry
{
    public static IEnumerable<Point3> BoxSamples(Point3 min, Point3 max)
    {
        yield return new((min.X + max.X) / 2, (min.Y + max.Y) / 2, (min.Z + max.Z) / 2);
        if (max.X <= min.X || max.Y <= min.Y || max.Z <= min.Z) yield break;
        double top = max.Y - Math.Min(0.01, (max.Y - min.Y) / 10);
        foreach (double tx in new[] { 0.2, 0.8 })
        foreach (double tz in new[] { 0.2, 0.8 })
            yield return new(min.X + (max.X - min.X) * tx, top, min.Z + (max.Z - min.Z) * tz);
    }

    public static double Normalize(double degrees) => (degrees % 360 + 360) % 360;
    public static double Distance(Point3 a, Point3 b) => Math.Sqrt(
        Math.Pow(a.X - b.X, 2) + Math.Pow(a.Y - b.Y, 2) + Math.Pow(a.Z - b.Z, 2));

    public static (double Yaw, double Pitch) LookAt(Point3 eye, Point3 target)
    {
        double x = target.X - eye.X, y = target.Y - eye.Y, z = target.Z - eye.Z;
        return (Normalize(Math.Atan2(x, z) * 180 / Math.PI),
            -Math.Atan2(y, Math.Sqrt(x * x + z * z)) * 180 / Math.PI);
    }

    public static bool InCone(Point3 eye, Point3 target, double yaw, double pitch, double radius)
    {
        double distance = Distance(eye, target);
        if (!double.IsFinite(distance) || distance < 0.01 || distance > radius) return false;
        var look = LookAt(eye, target);
        double yawDelta = Math.Abs(Normalize(look.Yaw - yaw + 180) - 180);
        return yawDelta <= 60 && Math.Abs(look.Pitch - pitch) <= 45;
    }
}
