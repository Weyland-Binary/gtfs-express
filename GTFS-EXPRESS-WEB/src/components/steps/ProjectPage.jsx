/** A modify project's screen: the hosted edition's, in the community edition. */
import React from "react";
import HostedOnly from "../common/HostedOnly";
import { useNavigate } from "../../utils/routes";

export default function ProjectPage() {
  const navigate = useNavigate();
  return <HostedOnly onClose={() => navigate("/")} />;
}
