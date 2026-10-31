using System;
using GameQA.Agent;
using MCPForUnity.Editor.Helpers;
using MCPForUnity.Editor.Tools;
using Newtonsoft.Json.Linq;

[McpForUnityTool("gameqa", Description = "Editor QA adapter. action=capabilities|observe|open|run|status|cancel|close. Input requires token/epoch from open. run accepts request_id, timeout_seconds and steps; poll status for effects.")]
public static class GameQaTool
{
    public static object HandleCommand(JObject @params)
    {
        try { return new SuccessResponse("QA adapter response; inspect job status for actual outcome.", AgentAdapter.Handle(@params)); }
        catch (Exception e)
        {
            // A command may already be running: an error is never an instruction to resend with a new ID.
            return new ErrorResponse(e.Message, new { exception_type = e.GetType().Name, automatic_replay = false });
        }
    }
}
