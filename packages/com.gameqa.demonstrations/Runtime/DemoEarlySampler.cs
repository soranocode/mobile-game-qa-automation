#if UNITY_EDITOR
using UnityEngine;
namespace QaDemonstrations
{
    [DefaultExecutionOrder(-32000)]
    public sealed class DemoEarlySampler : MonoBehaviour
    {
        private void Update() { DemoCapture.CaptureInput(); }
    }
}
#endif
