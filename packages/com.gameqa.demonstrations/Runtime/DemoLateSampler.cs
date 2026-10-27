#if UNITY_EDITOR
using UnityEngine;
namespace QaDemonstrations
{
    [DefaultExecutionOrder(32000)]
    public sealed class DemoLateSampler : MonoBehaviour
    {
        private void LateUpdate() { DemoCapture.CaptureState(); }
        private void OnGUI() { DemoCapture.Overlay(); }
    }
}
#endif
