using VintageStoryAI;

var eye = new Point3(100, 10, 100);
int checks = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    checks++;
}
foreach (var (point, yaw) in new[] {
    (new Point3(100, 10, 101), 0d), (new Point3(101, 10, 100), 90d),
    (new Point3(100, 10, 99), 180d), (new Point3(99, 10, 100), 270d) })
{
    var look = SceneGeometry.LookAt(eye, point);
    Check(Math.Abs(look.Yaw - yaw) < 0.001 && look.Pitch == 0, "cardinal look");
    Check(SceneGeometry.InCone(eye, point, yaw, 0, 6), "in view");
    Check(!SceneGeometry.InCone(eye, point, yaw + 180, 0, 6), "behind camera");
}
Check(SceneGeometry.LookAt(eye, new(100, 9, 101)).Pitch == 45, "down positive");
Check(SceneGeometry.LookAt(eye, new(100, 11, 101)).Pitch == -45, "up negative");
Check(SceneGeometry.InCone(eye, new(100, 10, 101), 359, 0, 6), "yaw wrap");
Check(!SceneGeometry.InCone(eye, new(100, 10, 107), 0, 0, 6), "range");
Check(!SceneGeometry.InCone(eye, new(100, 0, 101), 0, 0, 20), "pitch outside cone");
Check(!SceneGeometry.InCone(eye, eye, 0, 0, 6), "zero distance");
Check(!SceneGeometry.InCone(eye, new(double.NaN, 0, 0), 0, 0, 6), "nonfinite");
var samples = SceneGeometry.BoxSamples(new(0, 0, 0), new(1, 1, 1)).ToArray();
Check(samples.Length == 5 && samples[0] == new Point3(0.5, 0.5, 0.5), "center plus top samples");
Check(samples.All(p => p.X > 0 && p.X < 1 && p.Y > 0 && p.Y < 1 && p.Z > 0 && p.Z < 1), "rays end inside block");
Check(SceneGeometry.BoxSamples(new(0, 0, 0), new(1, 0.01, 1)).All(p => p.Y > 0 && p.Y < 0.01), "thin box samples");
// Eye on an upper ledge: at its edge the center ray is already inside ground,
// while a far-top ray clears it. Regression for missed one-block descents.
double EdgeHeight(Point3 end) => 3.7 + (end.Y - 3.7) * (0.62 / (end.Z + 0.62));
Check(EdgeHeight(samples[0]) < 2 && samples.Skip(1).Any(p => EdgeHeight(p) > 2), "top sample clears ledge");
Console.WriteLine($"{checks} geometry checks passed.");
LifeTests.Run();
ControlHoldTests.Run();
